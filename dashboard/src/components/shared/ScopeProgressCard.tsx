import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { colors } from '@/lib/tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScopeNode {
  id: string;
  label: string;
  type: 'initiative' | 'workstream' | 'milestone' | 'task';
  status?: 'done' | 'active' | 'pending' | 'blocked' | 'failed';
  progress?: { done: number; total: number };
  children?: ScopeNode[];
}

interface ScopeProgressCardProps {
  nodes: ScopeNode[];
  className?: string;
  /** Highlight this node as the active context */
  activeId?: string | null;
  /** Compact mode for inline use in lists */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Builders — construct ScopeNode trees from various data shapes
// ---------------------------------------------------------------------------

export function buildScopeFromSliceRun(input: {
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  workstreamTitle?: string | null;
  taskIds?: string[];
  milestoneIds?: string[];
  scopeProgress?: {
    totalTasks: number;
    completedTasks: number;
    milestones?: Array<{ id: string; title: string; total: number; done: number }>;
  } | null;
  status?: string | null;
}): ScopeNode[] {
  const root: ScopeNode[] = [];

  // Initiative level
  if (input.initiativeId) {
    const initiativeNode: ScopeNode = {
      id: input.initiativeId,
      label: input.initiativeTitle || shortId(input.initiativeId, 'Initiative'),
      type: 'initiative',
      children: [],
    };

    // Workstream level
    if (input.workstreamId) {
      const wsStatus = resolveStatus(input.status);
      const wsNode: ScopeNode = {
        id: input.workstreamId,
        label: input.workstreamTitle || shortId(input.workstreamId, 'Workstream'),
        type: 'workstream',
        status: wsStatus,
        progress: input.scopeProgress
          ? { done: input.scopeProgress.completedTasks, total: input.scopeProgress.totalTasks }
          : undefined,
        children: [],
      };

      // Milestones
      if (input.scopeProgress?.milestones && input.scopeProgress.milestones.length > 0) {
        for (const ms of input.scopeProgress.milestones) {
          const msStatus: ScopeNode['status'] =
            ms.done >= ms.total ? 'done' : ms.done > 0 ? 'active' : 'pending';
          const msNode: ScopeNode = {
            id: ms.id,
            label: ms.title || shortId(ms.id, 'Milestone'),
            type: 'milestone',
            status: msStatus,
            progress: { done: ms.done, total: ms.total },
          };

          // Task placeholders under milestone
          if (ms.total > 0) {
            msNode.children = Array.from({ length: Math.min(ms.total, 6) }, (_, i) => ({
              id: `${ms.id}-task-${i}`,
              label: `Task ${i + 1}`,
              type: 'task' as const,
              status: (i < ms.done ? 'done' : 'pending') as ScopeNode['status'],
            }));
            if (ms.total > 6) {
              msNode.children.push({
                id: `${ms.id}-task-overflow`,
                label: `+${ms.total - 6} more`,
                type: 'task',
                status: 'pending',
              });
            }
          }

          wsNode.children!.push(msNode);
        }
      } else if (input.taskIds && input.taskIds.length > 0) {
        // Tasks directly under workstream (no milestones)
        const completedCount = input.scopeProgress?.completedTasks ?? 0;
        const tasks = input.taskIds.slice(0, 6).map((tid, i) => ({
          id: tid,
          label: shortId(tid, 'Task'),
          type: 'task' as const,
          status: (i < completedCount ? 'done' : 'pending') as ScopeNode['status'],
        }));
        if (input.taskIds.length > 6) {
          tasks.push({
            id: 'overflow',
            label: `+${input.taskIds.length - 6} more`,
            type: 'task' as const,
            status: 'pending' as const,
          });
        }
        wsNode.children = tasks;
      }

      initiativeNode.children!.push(wsNode);
    }

    root.push(initiativeNode);
  }

  return root;
}

function shortId(id: string, prefix: string): string {
  if (!id || id.length < 8) return prefix;
  return `${prefix} ${id.slice(0, 6)}`;
}

function resolveStatus(status?: string | null): ScopeNode['status'] {
  if (!status) return 'pending';
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'running' || status === 'in_progress' || status === 'needs_review') return 'active';
  if (status === 'failed') return 'failed';
  if (status === 'blocked' || status === 'awaiting_input') return 'blocked';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Status visuals
// ---------------------------------------------------------------------------

function statusColor(status: ScopeNode['status']): string {
  switch (status) {
    case 'done': return colors.lime;
    case 'active': return colors.teal;
    case 'blocked': return colors.amber;
    case 'failed': return colors.red;
    default: return 'rgba(255,255,255,0.15)';
  }
}

function statusDotStyle(status: ScopeNode['status']): React.CSSProperties {
  const color = statusColor(status);
  return {
    backgroundColor: status === 'pending' ? 'transparent' : color,
    borderColor: color,
    borderWidth: 1.5,
    borderStyle: 'solid',
  };
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

const ProgressBar = memo(function ProgressBar({
  done,
  total,
  color,
}: {
  done: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.max(2, Math.round((done / total) * 100)) : 0;
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
      <motion.div
        className="h-full rounded-full"
        style={{ backgroundColor: color }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Task dots — compact visual for task completion
// ---------------------------------------------------------------------------

const TaskDots = memo(function TaskDots({
  done,
  total,
}: {
  done: number;
  total: number;
}) {
  const maxDots = Math.min(total, 12);
  const overflow = total > 12;
  return (
    <div className="flex items-center gap-[3px]">
      {Array.from({ length: maxDots }, (_, i) => (
        <span
          key={i}
          className="inline-block h-[5px] w-[5px] rounded-full transition-colors"
          style={{
            backgroundColor: i < done ? colors.lime : 'rgba(255,255,255,0.08)',
          }}
        />
      ))}
      {overflow && (
        <span className="ml-0.5 text-[9px] tabular-nums text-white/20">
          +{total - 12}
        </span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Scope tree node renderer
// ---------------------------------------------------------------------------

function ScopeTreeNode({
  node,
  depth,
  isLast,
  activeId,
  compact,
  index,
}: {
  node: ScopeNode;
  depth: number;
  isLast: boolean;
  activeId?: string | null;
  compact?: boolean;
  index: number;
}) {
  const isActive = activeId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const hasProgress = node.progress && node.progress.total > 0;

  return (
    <div>
      <motion.div
        initial={{ opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.025, duration: 0.2 }}
        className="flex items-start gap-2"
        style={{ paddingLeft: depth * 16 }}
      >
        {/* Vertical line connector */}
        {depth > 0 && (
          <div className="relative flex h-full w-3 flex-shrink-0 items-start justify-center pt-[7px]">
            <div
              className="absolute left-1/2 top-0 w-px -translate-x-1/2"
              style={{
                height: isLast ? 7 : '100%',
                backgroundColor: 'rgba(255,255,255,0.06)',
              }}
            />
            <div
              className="absolute left-1/2 top-[7px] h-px w-2"
              style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
            />
          </div>
        )}

        {/* Icon */}
        <div className="flex-shrink-0 pt-px">
          {node.type === 'task' ? (
            <span
              className="inline-block h-[7px] w-[7px] rounded-full"
              style={statusDotStyle(node.status)}
            />
          ) : (
            <EntityIcon
              type={node.type}
              size={compact ? 11 : 13}
              accent={isActive ? colors.lime : undefined}
            />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={`min-w-0 truncate leading-tight ${
                node.type === 'task'
                  ? 'text-[11px] text-white/30'
                  : node.type === 'milestone'
                    ? 'text-[12px] font-medium text-white/50'
                    : 'text-[12px] font-medium text-white/70'
              } ${isActive ? '!text-white/90' : ''}`}
            >
              {node.label}
            </span>
            {hasProgress && (
              <span className="flex-shrink-0 text-[10px] tabular-nums text-white/20">
                {node.progress!.done}/{node.progress!.total}
              </span>
            )}
          </div>

          {/* Progress bar for workstream/milestone */}
          {hasProgress && node.type !== 'task' && (
            <div className="mt-1 max-w-[140px]">
              <ProgressBar
                done={node.progress!.done}
                total={node.progress!.total}
                color={statusColor(node.status)}
              />
            </div>
          )}
        </div>
      </motion.div>

      {/* Children */}
      {hasChildren && (
        <div className="mt-0.5">
          {node.children!.map((child, i) => (
            <ScopeTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={i === node.children!.length - 1}
              activeId={activeId}
              compact={compact}
              index={index + i + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const ScopeProgressCard = memo(function ScopeProgressCard({
  nodes,
  className,
  activeId,
  compact,
}: ScopeProgressCardProps) {
  if (nodes.length === 0) return null;

  return (
    <div className={className}>
      {nodes.map((node, i) => (
        <ScopeTreeNode
          key={node.id}
          node={node}
          depth={0}
          isLast={i === nodes.length - 1}
          activeId={activeId}
          compact={compact}
          index={i}
        />
      ))}
    </div>
  );
});
