import { colors } from '@/lib/tokens';
import type { InitiativeTask, Initiative } from '@/types';
import { statusRank } from '@/lib/entityStatusColors';
import { TaskChip } from './TaskChip';
import { resolveAgentPersona } from './AgentInference';

const RUNNING_STATUSES = new Set(['active', 'in_progress', 'running', 'working', 'dispatching']);

function parsePriorityNum(priority: string | null | undefined): number {
  if (!priority) return 50;
  const lower = priority.trim().toLowerCase();
  if (lower === 'urgent' || lower === 'p0') return 10;
  if (lower === 'high' || lower === 'p1') return 25;
  if (lower === 'medium' || lower === 'p2') return 50;
  if (lower === 'low' || lower === 'p3' || lower === 'p4') return 75;
  const numeric = Number(lower.replace(/^p/, ''));
  return Number.isFinite(numeric) ? numeric : 50;
}

interface TaskSwimLanesProps {
  tasks: InitiativeTask[];
  initiative: Initiative;
  /** Optional: agent identifier executing this initiative's workstream. */
  agentId?: string | null;
  /** Optional: agent display name. */
  agentName?: string | null;
}

type StatusGroup = {
  label: string;
  color: string;
  tasks: InitiativeTask[];
  isRunning: boolean;
};

const groupTasks = (tasks: InitiativeTask[]): StatusGroup[] => {
  const groups: Record<string, InitiativeTask[]> = {
    blocked: [],
    active: [],
    todo: [],
    done: [],
  };

  tasks.forEach((task) => {
    const lower = task.status.toLowerCase();
    if (lower === 'blocked') groups.blocked.push(task);
    else if (lower === 'active' || lower === 'in_progress') groups.active.push(task);
    else if (lower === 'done' || lower === 'completed') groups.done.push(task);
    else groups.todo.push(task);
  });

  Object.values(groups).forEach((group) =>
    group.sort((a, b) => {
      const sr = statusRank(a.status) - statusRank(b.status);
      if (sr !== 0) return sr;
      const pr = parsePriorityNum(a.priority) - parsePriorityNum(b.priority);
      if (pr !== 0) return pr;
      const aEta = a.dueDate ? Date.parse(a.dueDate) : Infinity;
      const bEta = b.dueDate ? Date.parse(b.dueDate) : Infinity;
      if (aEta !== bEta) return aEta - bEta;
      return (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0);
    })
  );

  return [
    { label: 'Blocked', color: colors.red, tasks: groups.blocked, isRunning: false },
    { label: 'Active', color: colors.lime, tasks: groups.active, isRunning: true },
    { label: 'Todo', color: 'rgba(255,255,255,0.4)', tasks: groups.todo, isRunning: false },
    { label: 'Done', color: colors.teal, tasks: groups.done, isRunning: false },
  ].filter((g) => g.tasks.length > 0);
};

export function TaskSwimLanes({ tasks, initiative, agentId, agentName }: TaskSwimLanesProps) {
  if (!tasks.length) return null;

  const groups = groupTasks(tasks);

  // Resolve agent persona for running lane accent
  const agentPersona = agentId || agentName
    ? resolveAgentPersona(agentId, agentName)
    : null;

  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-1">
      {groups.map((group) => {
        // Determine if any tasks in this group are in a running state
        const hasRunningTask = group.isRunning &&
          group.tasks.some((t) => RUNNING_STATUSES.has(t.status.toLowerCase()));
        const laneAgentColor = hasRunningTask && agentPersona ? agentPersona.color : null;

        return (
          <div
            key={group.label}
            className="flex items-center gap-1.5 flex-shrink-0 rounded-md px-1.5 py-0.5 transition-colors"
            style={
              laneAgentColor
                ? {
                    borderLeft: `2px solid ${laneAgentColor}`,
                    backgroundColor: `${laneAgentColor}08`,
                  }
                : undefined
            }
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: group.color }}
            />
            <span className="text-micro text-muted uppercase tracking-wider">
              {group.label} ({group.tasks.length})
            </span>

            {/* Show agent executing indicator for running lane */}
            {laneAgentColor && agentPersona && (
              <span
                className="text-[10px] font-semibold truncate max-w-[80px]"
                style={{ color: laneAgentColor }}
                title={agentPersona.displayLabel}
              >
                {agentPersona.name}
              </span>
            )}

            <div className="flex items-center gap-1 ml-1">
              {group.tasks.slice(0, 6).map((task) => (
                <TaskChip key={task.id} task={task} initiative={initiative} />
              ))}
              {group.tasks.length > 6 && (
                <span className="text-micro text-muted ml-0.5">
                  +{group.tasks.length - 6}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
