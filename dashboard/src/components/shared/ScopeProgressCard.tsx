import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
  /** Agent assigned to this scope level */
  agent?: { name: string; id?: string | null } | null;
  /** Whether this is the specific entity under review / in focus */
  highlight?: boolean;
}

interface ScopeProgressCardProps {
  nodes: ScopeNode[];
  className?: string;
  /** Highlight this node as the active context */
  activeId?: string | null;
  /** Compact mode for inline use in lists */
  compact?: boolean;
  /** Max tasks shown before "see all" (default 4) */
  taskLimit?: number;
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
  agentName?: string | null;
  agentId?: string | null;
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
        agent: input.agentName ? { name: input.agentName, id: input.agentId } : null,
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

          // All tasks under milestone — no artificial limit in builder
          if (ms.total > 0) {
            msNode.children = Array.from({ length: ms.total }, (_, i) => ({
              id: `${ms.id}-task-${i}`,
              label: `Task ${i + 1}`,
              type: 'task' as const,
              status: (i < ms.done ? 'done' : 'pending') as ScopeNode['status'],
            }));
          }

          wsNode.children!.push(msNode);
        }
      } else if (input.taskIds && input.taskIds.length > 0) {
        // Tasks directly under workstream (no milestones)
        const completedCount = input.scopeProgress?.completedTasks ?? 0;
        wsNode.children = input.taskIds.map((tid, i) => ({
          id: tid,
          label: shortId(tid, 'Task'),
          type: 'task' as const,
          status: (i < completedCount ? 'done' : 'pending') as ScopeNode['status'],
        }));
      }

      initiativeNode.children!.push(wsNode);
    }

    root.push(initiativeNode);
  }

  return root;
}

/** Lightweight builder for decision / triage context (no scopeProgress data) */
export function buildScopeFromContext(input: {
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  workstreamTitle?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  agentName?: string | null;
  agentId?: string | null;
  status?: string | null;
}): ScopeNode[] {
  const root: ScopeNode[] = [];
  if (!input.initiativeId && !input.workstreamId) return root;

  const initiativeNode: ScopeNode | null = input.initiativeId
    ? {
        id: input.initiativeId,
        label: input.initiativeTitle || shortId(input.initiativeId, 'Initiative'),
        type: 'initiative',
        children: [],
      }
    : null;

  const wsNode: ScopeNode | null = input.workstreamId
    ? {
        id: input.workstreamId,
        label: input.workstreamTitle || shortId(input.workstreamId, 'Workstream'),
        type: 'workstream',
        status: resolveStatus(input.status),
        agent: input.agentName ? { name: input.agentName, id: input.agentId } : null,
        children: [],
      }
    : null;

  const taskNode: ScopeNode | null = input.taskId
    ? {
        id: input.taskId,
        label: input.taskTitle || shortId(input.taskId, 'Task'),
        type: 'task',
        highlight: true,
      }
    : null;

  // Assemble tree
  if (wsNode && taskNode) wsNode.children = [taskNode];
  if (initiativeNode && wsNode) {
    initiativeNode.children = [wsNode];
    root.push(initiativeNode);
  } else if (wsNode) {
    root.push(wsNode);
  } else if (initiativeNode) {
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
// Scope tree node renderer
// ---------------------------------------------------------------------------

function ScopeTreeNode({
  node,
  depth,
  isLast,
  activeId,
  compact,
  index,
  taskLimit,
  expanded,
  onToggleExpand,
}: {
  node: ScopeNode;
  depth: number;
  isLast: boolean;
  activeId?: string | null;
  compact?: boolean;
  index: number;
  taskLimit: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const isActive = activeId === node.id || node.highlight;
  const hasProgress = node.progress && node.progress.total > 0;

  // Determine visible children with task truncation
  const allChildren = node.children ?? [];
  const taskChildren = allChildren.filter((c) => c.type === 'task');
  const nonTaskChildren = allChildren.filter((c) => c.type !== 'task');
  const hasTaskOverflow = taskChildren.length > taskLimit && !expanded;
  const visibleTasks = hasTaskOverflow ? taskChildren.slice(0, taskLimit) : taskChildren;
  const hiddenCount = taskChildren.length - visibleTasks.length;
  const visibleChildren = [...nonTaskChildren, ...visibleTasks];
  const hasChildren = visibleChildren.length > 0 || hasTaskOverflow;

  return (
    <div>
      <motion.div
        initial={{ opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.02, duration: 0.18 }}
        className={`flex items-start gap-2 py-[1px] ${isActive ? 'rounded-md bg-white/[0.03]' : ''}`}
        style={{ paddingLeft: depth * (compact ? 12 : 16) }}
      >
        {/* Vertical line connector */}
        {depth > 0 && (
          <div className="relative flex w-3 flex-shrink-0 items-start justify-center pt-[7px]">
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
        <div className="flex-shrink-0 pt-[2px]">
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
          <div className="flex items-baseline gap-1.5">
            <span
              className={`min-w-0 truncate leading-tight ${
                node.type === 'task'
                  ? `text-[11px] ${node.status === 'done' ? 'text-white/40 line-through decoration-white/10' : 'text-white/30'}`
                  : node.type === 'milestone'
                    ? 'text-[12px] font-medium text-white/50'
                    : 'text-[12px] font-medium text-white/70'
              } ${isActive ? '!text-white/90 !no-underline' : ''}`}
            >
              {node.label}
            </span>
            {hasProgress && (
              <span className="flex-shrink-0 text-[10px] tabular-nums text-white/20">
                {node.progress!.done}/{node.progress!.total}
              </span>
            )}
            {/* Agent badge — small, right-aligned */}
            {node.agent && (
              <span className="ml-auto flex-shrink-0 rounded-full bg-white/[0.05] px-1.5 py-px text-[9px] font-medium text-white/25">
                {node.agent.name}
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
        <div className="mt-px">
          {visibleChildren.map((child, i) => (
            <ScopeTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={i === visibleChildren.length - 1 && !hasTaskOverflow}
              activeId={activeId}
              compact={compact}
              index={index + i + 1}
              taskLimit={taskLimit}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
            />
          ))}
          {/* "See all" / overflow toggle */}
          {hasTaskOverflow && (
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: (index + visibleChildren.length + 1) * 0.02 }}
              onClick={onToggleExpand}
              className="flex items-center gap-1.5 py-[2px] text-[10px] font-medium text-white/25 transition-colors hover:text-white/45"
              style={{ paddingLeft: (depth + 1) * (compact ? 12 : 16) + 20 }}
            >
              <span className="inline-block h-px w-2 bg-white/10" />
              +{hiddenCount} more · see all
            </motion.button>
          )}
          {/* Collapse toggle when expanded past limit */}
          <AnimatePresence>
            {expanded && taskChildren.length > taskLimit && (
              <motion.button
                type="button"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                onClick={onToggleExpand}
                className="flex items-center gap-1.5 py-[2px] text-[10px] font-medium text-white/25 transition-colors hover:text-white/45"
                style={{ paddingLeft: (depth + 1) * (compact ? 12 : 16) + 20 }}
              >
                show less
              </motion.button>
            )}
          </AnimatePresence>
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
  taskLimit = 4,
}: ScopeProgressCardProps) {
  const [expanded, setExpanded] = useState(false);

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
          taskLimit={taskLimit}
          expanded={expanded}
          onToggleExpand={() => setExpanded((e) => !e)}
        />
      ))}
    </div>
  );
});
