import { statusColor } from '@/lib/entityStatusColors';
import type { InitiativeTask, Initiative } from '@/types';
import { useMissionControl } from './MissionControlContext';

interface TaskChipProps {
  task: InitiativeTask;
  initiative: Initiative;
}

export function TaskChip({ task, initiative }: TaskChipProps) {
  const { openModal } = useMissionControl();

  return (
    <button
      onClick={() => openModal({ type: 'task', entity: task, initiative })}
      className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-left transition-all hover:bg-white/[0.06] hover-lift min-w-0"
    >
      <span
        className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: statusColor(task.status) }}
      />
      <span className="text-[11px] text-white/80 truncate">{task.title}</span>
      {task.priority && (
        <span className="text-[9px] text-white/30 uppercase flex-shrink-0">
          {task.priority}
        </span>
      )}
    </button>
  );
}
