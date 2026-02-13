import { colors } from '@/lib/tokens';
import type { InitiativeTask, Initiative } from '@/types';
import { statusRank } from '@/lib/entityStatusColors';
import { TaskChip } from './TaskChip';

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
}

type StatusGroup = {
  label: string;
  color: string;
  tasks: InitiativeTask[];
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
    { label: 'Blocked', color: colors.red, tasks: groups.blocked },
    { label: 'Active', color: colors.lime, tasks: groups.active },
    { label: 'Todo', color: 'rgba(255,255,255,0.4)', tasks: groups.todo },
    { label: 'Done', color: colors.teal, tasks: groups.done },
  ].filter((g) => g.tasks.length > 0);
};

export function TaskSwimLanes({ tasks, initiative }: TaskSwimLanesProps) {
  if (!tasks.length) return null;

  const groups = groupTasks(tasks);

  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-1">
      {groups.map((group) => (
        <div key={group.label} className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: group.color }}
          />
          <span className="text-micro text-muted uppercase tracking-wider">
            {group.label} ({group.tasks.length})
          </span>
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
      ))}
    </div>
  );
}
