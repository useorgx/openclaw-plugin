import { useState } from 'react';
import { colors } from '@/lib/tokens';
import type { Initiative, InitiativeTask } from '@/types';
import {
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';

interface TaskDetailProps {
  task: InitiativeTask;
  initiative: Initiative;
}

export function TaskDetail({ task, initiative }: TaskDetailProps) {
  const { agentEntityMap, openModal, mutations, closeModal } = useMissionControl();
  const agents = agentEntityMap.get(task.id) ?? agentEntityMap.get(initiative.id) ?? [];
  const [confirmDelete, setConfirmDelete] = useState(false);

  const status = task.status.toLowerCase();

  const handleAction = (action: string) => {
    mutations.entityAction.mutate(
      { type: 'task', id: task.id, action },
      { onSuccess: () => closeModal() },
    );
  };

  const handleDelete = () => {
    mutations.deleteEntity.mutate(
      { type: 'task', id: task.id },
      { onSuccess: () => closeModal() },
    );
  };

  const isMutating =
    mutations.entityAction.isPending || mutations.deleteEntity.isPending;

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <button
            onClick={() => openModal({ type: 'initiative', entity: initiative })}
            className="break-words text-white/45 transition-colors hover:text-white"
          >
            {initiative.name}
          </button>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="break-words font-medium text-white/70">{task.title}</span>
        </div>

        {/* Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="break-words text-[16px] font-semibold text-white">{task.title}</h2>
            <span
              className={`text-[10px] px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getTaskStatusClass(task.status)}`}
            >
              {formatEntityStatus(task.status)}
            </span>
          </div>
          {task.description && (
            <MarkdownText
              text={task.description}
              mode="block"
              className="text-[13px] text-white/50 leading-relaxed"
            />
          )}
          {agents.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/30 uppercase tracking-wider">Agents</span>
              <InferredAgentAvatars agents={agents} max={4} />
            </div>
          )}
        </div>

        {/* Details */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Status</div>
            <div className="text-[13px] text-white/80 mt-0.5">
              {formatEntityStatus(task.status)}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Priority</div>
            <div className="text-[13px] text-white/80 mt-0.5">
              {task.priority ?? '\u2014'}
            </div>
          </div>
          {task.dueDate && (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Due Date</div>
              <div className="text-[13px] text-white/80 mt-0.5">
                {new Date(task.dueDate).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>

        {(mutations.entityAction.error || mutations.deleteEntity.error) && (
          <div className="text-[11px] px-1" style={{ color: `${colors.red}b3` }}>
            {(mutations.entityAction.error as Error)?.message ??
              (mutations.deleteEntity.error as Error)?.message}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="border-t border-white/[0.06] bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {status === 'todo' && (
            <ActionButton label="Start" color={colors.lime} variant="primary" onClick={() => handleAction('start')} disabled={isMutating} />
          )}
          {(status === 'in_progress' || status === 'active') && (
            <ActionButton label="Complete" color={colors.teal} variant="primary" onClick={() => handleAction('complete')} disabled={isMutating} />
          )}
          {(status === 'todo' || status === 'in_progress' || status === 'active') && (
            <ActionButton label="Block" color={colors.red} variant="destructive" onClick={() => handleAction('block')} disabled={isMutating} />
          )}
          {status === 'blocked' && (
            <ActionButton label="Unblock" color={colors.amber} onClick={() => handleAction('unblock')} disabled={isMutating} />
          )}

          <div className="flex-1" />

          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px]" style={{ color: `${colors.red}b3` }}>Delete?</span>
              <ActionButton label="Yes" color={colors.red} onClick={handleDelete} disabled={isMutating} />
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={isMutating}
                className="text-[11px] px-3 py-1.5 rounded-lg border bg-white/5 text-white/50 border-white/10 hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={isMutating}
              className="text-[11px] px-3 py-1.5 rounded-lg border bg-white/5 text-white/40 border-white/10 transition-colors disabled:opacity-50"
              style={{ ['--hover-bg' as string]: `${colors.red}20` }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  color,
  onClick,
  disabled,
  variant = 'secondary',
}: {
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'destructive';
}) {
  const sharedStyle =
    variant === 'primary'
      ? { backgroundColor: color, color: '#05060A', borderColor: `${color}CC` }
      : variant === 'destructive'
        ? { backgroundColor: `${color}14`, color, borderColor: `${color}40` }
        : { backgroundColor: `${color}20`, color, borderColor: `${color}30` };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={sharedStyle}
    >
      {label}
    </button>
  );
}
