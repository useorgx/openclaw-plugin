import { statusColor } from '@/lib/entityStatusColors';
import type { InitiativeTask, Initiative } from '@/types';
import { useMissionControl } from './MissionControlContext';

interface TaskChipProps {
  task: InitiativeTask;
  initiative: Initiative;
}

export function TaskChip({ task, initiative }: TaskChipProps) {
  const { openModal } = useMissionControl();

  const taskLabel =
    task.sequenceIndex != null
      ? `T${task.sequenceIndex + 1}`
      : task.hierarchyLabel ?? null;

  return (
    <button
      onClick={() => openModal({ type: 'task', entity: task, initiative })}
      className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06] min-w-0"
    >
      <span
        className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: statusColor(task.status) }}
      />
      {taskLabel && (
        <span className="text-[10px] tracking-wider uppercase font-mono tabular-nums opacity-60 hover:opacity-100 transition-opacity leading-none select-none flex-shrink-0">
          {taskLabel}
        </span>
      )}
      <span className="text-caption text-primary truncate">{task.title}</span>
      {task.priority && (
        <span className="text-micro text-muted uppercase flex-shrink-0">
          {task.priority}
        </span>
      )}
    </button>
  );
}
