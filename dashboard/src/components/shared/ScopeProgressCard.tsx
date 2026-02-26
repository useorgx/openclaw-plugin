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
// Builders
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

  if (input.initiativeId) {
    const initiativeNode: ScopeNode = {
      id: input.initiativeId,
      label: input.initiativeTitle || shortId(input.initiativeId, 'Initiative'),
      type: 'initiative',
      children: [],
    };

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
// Layout constants
//
//  ROW_H      = total row height (padding + icon)
//  ICON_SZ    = entity icon diameter
//  TASK_DOT   = task dot diameter
//  GAP        = horizontal gap between icon and label
//  COL_W      = column width for one indent level (holds icon + gap)
//
//  Every node row is structured as:
//    [depth * COL_W left margin] [icon centered in COL_W] [gap] [label…]
//
//  The vertical connector runs at the horizontal center of the *parent's*
//  icon column, i.e. at  (depth-1)*COL_W + COL_W/2  from the left edge of
//  the tree.  The horizontal connector runs from that x to the child's icon
//  center at  depth*COL_W + COL_W/2.
// ---------------------------------------------------------------------------

const ICON_SZ = 16;
const ICON_SZ_COMPACT = 14;
const TASK_DOT_SZ = 8;
const GAP = 8;        // gap between icon and label
const ROW_H = 28;     // non-task row height
const ROW_H_TASK = 24; // task row height
const ROW_H_COMPACT = 24;
const ROW_H_TASK_COMPACT = 20;
const LINE_COLOR = 'rgba(255,255,255,0.07)';

function getLayout(compact: boolean | undefined) {
  const iconSz = compact ? ICON_SZ_COMPACT : ICON_SZ;
  // Column width = icon + gap, rounded up to feel spacious
  const colW = iconSz + GAP + 4;
  const rowH = compact ? ROW_H_COMPACT : ROW_H;
  const rowHTask = compact ? ROW_H_TASK_COMPACT : ROW_H_TASK;
  return { iconSz, colW, rowH, rowHTask };
}

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
  const isTask = node.type === 'task';
  const { iconSz, colW, rowH, rowHTask } = getLayout(compact);
  const thisRowH = isTask ? rowHTask : rowH;
  const thisIconSz = isTask ? TASK_DOT_SZ : iconSz;

  // Children
  const allChildren = node.children ?? [];
  const taskChildren = allChildren.filter((c) => c.type === 'task');
  const nonTaskChildren = allChildren.filter((c) => c.type !== 'task');
  const hasTaskOverflow = taskChildren.length > taskLimit && !expanded;
  const visibleTasks = hasTaskOverflow ? taskChildren.slice(0, taskLimit) : taskChildren;
  const hiddenCount = taskChildren.length - visibleTasks.length;
  const visibleChildren = [...nonTaskChildren, ...visibleTasks];
  const hasChildren = visibleChildren.length > 0 || hasTaskOverflow;

  // X positions (from left edge of this node's container)
  // The parent's icon center is at x = 0 + colW/2 when depth > 0 relative
  // to the parent. But since we nest, the connector for THIS node is drawn
  // at the parent's icon center, which from *our* coordinate system is at
  // x = -colW + colW/2 = -colW/2.  However we use absolute left from the
  // tree root, so:
  //   parentIconCenterX = (depth - 1) * colW + colW / 2
  //   thisIconCenterX   = depth * colW + colW / 2
  //   thisIconCenterY   = thisRowH / 2

  return (
    <div className="relative" style={{ minHeight: thisRowH }}>
      {/* ── Connectors from parent ── */}
      {depth > 0 && (
        <>
          {/* Vertical line: from top of this node down to icon center.
              For non-last siblings, extends to the full bottom so the next
              sibling's connector continues from it. */}
          <div
            className="absolute w-px"
            style={{
              backgroundColor: LINE_COLOR,
              left: (depth - 1) * colW + colW / 2,
              top: 0,
              bottom: isLast ? undefined : 0,
              height: isLast ? thisRowH / 2 : undefined,
            }}
          />
          {/* Horizontal line: from parent icon center-x to this icon center-x */}
          <div
            className="absolute h-px"
            style={{
              backgroundColor: LINE_COLOR,
              left: (depth - 1) * colW + colW / 2,
              top: thisRowH / 2,
              width: colW,
            }}
          />
        </>
      )}

      {/* ── Node row ── */}
      <motion.div
        initial={{ opacity: 0, x: -3 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.02, duration: 0.15 }}
        className={`flex items-center ${isActive ? 'rounded-md bg-white/[0.03]' : ''}`}
        style={{
          height: thisRowH,
          paddingLeft: depth * colW,
        }}
      >
        {/* Icon — centered in colW */}
        <div
          className="flex flex-shrink-0 items-center justify-center"
          style={{ width: colW, height: thisRowH }}
        >
          {isTask ? (
            <span
              className="inline-block rounded-full"
              style={{
                ...statusDotStyle(node.status),
                width: TASK_DOT_SZ,
                height: TASK_DOT_SZ,
              }}
            />
          ) : (
            <EntityIcon
              type={node.type}
              size={iconSz}
              accent={isActive ? colors.lime : undefined}
            />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 pr-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`min-w-0 truncate ${
                isTask
                  ? `text-[12px] leading-none ${node.status === 'done' ? 'text-white/40 line-through decoration-white/10' : 'text-white/35'}`
                  : node.type === 'milestone'
                    ? 'text-[13px] font-medium leading-none text-white/55'
                    : depth === 0
                      ? 'text-[13px] font-medium leading-none text-white/80'
                      : 'text-[13px] font-medium leading-none text-white/70'
              } ${isActive ? '!text-white/90 !no-underline' : ''}`}
            >
              {node.label}
            </span>
            {hasProgress && (
              <span className="flex-shrink-0 text-[10px] tabular-nums leading-none text-white/20">
                {node.progress!.done}/{node.progress!.total}
              </span>
            )}
            {node.agent && (
              <span className="ml-auto flex-shrink-0 rounded-full bg-white/[0.05] px-1.5 py-px text-[9px] font-medium leading-none text-white/25">
                {node.agent.name}
              </span>
            )}
          </div>

          {hasProgress && !isTask && (
            <div className="mt-1.5 max-w-[160px]">
              <ProgressBar
                done={node.progress!.done}
                total={node.progress!.total}
                color={statusColor(node.status)}
              />
            </div>
          )}
        </div>
      </motion.div>

      {/* ── Vertical guide: bridge from this icon center into children area ── */}
      {hasChildren && (
        <div
          className="absolute w-px"
          style={{
            backgroundColor: LINE_COLOR,
            left: depth * colW + colW / 2,
            top: thisRowH / 2,
            height: thisRowH / 2,
          }}
        />
      )}

      {/* ── Children ── */}
      {hasChildren && (
        <div>
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

          {hasTaskOverflow && (
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: (index + visibleChildren.length + 1) * 0.02 }}
              onClick={onToggleExpand}
              className="flex items-center text-[10px] font-medium text-white/25 transition-colors hover:text-white/45"
              style={{
                height: rowHTask,
                paddingLeft: (depth + 1) * colW + colW,
              }}
            >
              +{hiddenCount} more · see all
            </motion.button>
          )}

          <AnimatePresence>
            {expanded && taskChildren.length > taskLimit && (
              <motion.button
                type="button"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: rowHTask }}
                exit={{ opacity: 0, height: 0 }}
                onClick={onToggleExpand}
                className="flex items-center text-[10px] font-medium text-white/25 transition-colors hover:text-white/45"
                style={{
                  paddingLeft: (depth + 1) * colW + colW,
                }}
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
