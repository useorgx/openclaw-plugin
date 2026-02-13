import { useState } from 'react';
import { colors } from '@/lib/tokens';
import type { Initiative, InitiativeMilestone } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  getMilestoneStatusClass,
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { completionPercent, isDoneStatus } from '@/lib/progress';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';

interface MilestoneDetailProps {
  milestone: InitiativeMilestone;
  initiative: Initiative;
}

export function MilestoneDetail({ milestone, initiative }: MilestoneDetailProps) {
  const { openModal, closeModal, authToken, embedMode, mutations } = useMissionControl();
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [draftTitle, setDraftTitle] = useState(milestone.title);
  const [draftDescription, setDraftDescription] = useState(milestone.description ?? '');
  const [draftDueDate, setDraftDueDate] = useState(toDateInputValue(milestone.dueDate));
  const [draftStatus, setDraftStatus] = useState(milestone.status);

  const { details } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });

  const associatedTasks = details.tasks.filter(
    (t) => t.milestoneId === milestone.id
  );

  const isDone =
    milestone.status.toLowerCase() === 'done' ||
    milestone.status.toLowerCase() === 'completed';
  const doneTaskCount = associatedTasks.filter((t) => isDoneStatus(t.status)).length;
  const progressValue =
    associatedTasks.length > 0
      ? completionPercent(doneTaskCount, associatedTasks.length)
      : isDone
        ? 100
        : 0;

  const isMutating =
    mutations.entityAction.isPending ||
    mutations.createEntity.isPending ||
    mutations.updateEntity.isPending ||
    mutations.deleteEntity.isPending;

  const handleSaveEdits = () => {
    const title = draftTitle.trim();
    if (!title) {
      setNotice('Milestone title is required.');
      return;
    }

    setNotice(null);
    mutations.updateEntity.mutate(
      {
        type: 'milestone',
        id: milestone.id,
        title,
        description: draftDescription.trim() || null,
        due_date: draftDueDate || null,
        status: draftStatus,
      },
      {
        onSuccess: () => {
          setEditMode(false);
          setNotice('Milestone updated.');
        },
        onError: (error) => {
          setNotice(error instanceof Error ? error.message : 'Failed to update milestone.');
        },
      }
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-caption">
          <EntityIcon type="initiative" size={12} className="flex-shrink-0 opacity-80" />
          <button
            onClick={() => openModal({ type: 'initiative', entity: initiative })}
            className="break-words text-secondary transition-colors hover:text-white"
          >
            {initiative.name}
          </button>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-faint">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <EntityIcon type="milestone" size={12} className="flex-shrink-0 opacity-95" />
          <span className="break-words font-medium text-primary">{milestone.title}</span>
        </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <EntityIcon type="milestone" size={16} />
          <h2 className="text-title font-semibold text-white">
            {milestone.title}
          </h2>
          <span
            className={`text-micro px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(milestone.status)}`}
          >
            {formatEntityStatus(milestone.status)}
          </span>
        </div>
        {editMode ? (
          <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">Title</span>
              <input
                type="text"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">Description</span>
              <textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-micro uppercase tracking-[0.08em] text-muted">Due date</span>
                <input
                  type="date"
                  value={draftDueDate}
                  onChange={(event) => setDraftDueDate(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
                />
              </label>
              <label className="block">
                <span className="text-micro uppercase tracking-[0.08em] text-muted">Status</span>
                <select
                  value={draftStatus}
                  onChange={(event) => setDraftStatus(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
                >
                  {['planned', 'active', 'in_progress', 'at_risk', 'blocked', 'done'].map((status) => (
                    <option key={status} value={status}>
                      {formatEntityStatus(status)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : milestone.description ? (
          <p className="text-body text-secondary leading-relaxed">
            {milestone.description}
          </p>
        ) : (
          <p className="text-body text-muted">No description yet.</p>
        )}
        {notice && <div className="text-caption text-secondary">{notice}</div>}
      </div>

      {/* Details */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {milestone.dueDate && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <div className="text-micro uppercase tracking-[0.08em] text-muted">Due Date</div>
            <div className="text-body text-primary mt-0.5">
              {new Date(milestone.dueDate).toLocaleDateString()}
            </div>
          </div>
        )}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-micro uppercase tracking-[0.08em] text-muted">Associated Tasks</div>
          <div className="text-heading font-medium text-primary mt-0.5">
            {associatedTasks.length}
          </div>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-micro uppercase tracking-[0.08em] text-muted">Completion</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progressValue}%`, backgroundColor: colors.teal }}
              />
            </div>
            <div className="text-body text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {progressValue}%
            </div>
          </div>
          <div className="mt-1 text-micro text-muted">
            {doneTaskCount}/{associatedTasks.length} done
          </div>
        </div>
      </div>

      {/* Associated tasks */}
      {associatedTasks.length > 0 && (
        <div className="space-y-2">
          <span className="text-caption uppercase tracking-[0.08em] text-muted">
            Tasks
          </span>
          {associatedTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => openModal({ type: 'task', entity: task, initiative })}
              className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.06]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-body text-bright">{task.title}</span>
                <span className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getTaskStatusClass(task.status)}`}>
                  {formatEntityStatus(task.status)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Notes */}
      <div className="mt-2 space-y-2 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-micro font-semibold uppercase tracking-[0.14em] text-muted">
              Notes
            </p>
            <p className="mt-1 text-caption text-muted">
              Commentary thread for humans and agents on this milestone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNotes((prev) => !prev)}
            className="inline-flex items-center justify-center rounded-full border border-strong bg-white/[0.05] px-3 py-1.5 text-caption font-semibold tracking-wide text-primary transition-colors hover:bg-white/[0.09]"
          >
            {showNotes ? 'Hide' : 'Show'}
          </button>
        </div>
        {showNotes ? (
          <div className="pt-3 border-t border-subtle">
            <EntityCommentsPanel
              entityType="milestone"
              entityId={milestone.id}
              authToken={authToken}
              embedMode={embedMode}
            />
          </div>
        ) : null}
      </div>

      </div>

      {/* Actions */}
      <div className="border-t border-subtle bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {!isDone && milestone.status.toLowerCase() === 'planned' && (
            <EntityActionButton
              label="Start"
              color={colors.lime}
              variant="primary"
              onClick={() => mutations.entityAction.mutate({ type: 'milestone', id: milestone.id, action: 'start' })}
              disabled={isMutating}
            />
          )}
          {!isDone && (milestone.status.toLowerCase() === 'in_progress' || milestone.status.toLowerCase() === 'at_risk') && (
            <EntityActionButton
              label={
                associatedTasks.length > 0 && !associatedTasks.every((t) => isDoneStatus(t.status))
                  ? 'Complete (force)'
                  : 'Complete'
              }
              color={colors.teal}
              variant="primary"
              onClick={() => {
                const allDone = associatedTasks.length === 0 || associatedTasks.every((t) => isDoneStatus(t.status));
                mutations.entityAction.mutate({
                  type: 'milestone',
                  id: milestone.id,
                  action: 'complete',
                  force: !allDone,
                });
              }}
              disabled={isMutating}
            />
          )}
          {editMode ? (
            <>
              <EntityActionButton
                label="Save"
                color={colors.teal}
                variant="primary"
                onClick={handleSaveEdits}
                disabled={isMutating || !draftTitle.trim()}
              />
              <EntityActionButton
                label="Cancel"
                variant="ghost"
                onClick={() => {
                  setEditMode(false);
                  setDraftTitle(milestone.title);
                  setDraftDescription(milestone.description ?? '');
                  setDraftDueDate(toDateInputValue(milestone.dueDate));
                  setDraftStatus(milestone.status);
                  setNotice(null);
                }}
                disabled={isMutating}
              />
            </>
          ) : (
            <EntityActionButton
              label="Edit"
              variant="ghost"
              onClick={() => {
                setEditMode(true);
                setNotice(null);
              }}
              disabled={isMutating}
            />
          )}
          <div className="flex-1" />
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-caption text-secondary">Delete milestone?</span>
              <EntityActionButton
                label="Delete"
                color={colors.red}
                variant="destructive"
                onClick={() =>
                  mutations.deleteEntity.mutate(
                    { type: 'milestone', id: milestone.id },
                    {
                      onSuccess: () => closeModal(),
                      onError: (error) =>
                        setNotice(
                          error instanceof Error ? error.message : 'Failed to delete milestone.'
                        ),
                    }
                  )
                }
                disabled={isMutating}
              />
              <EntityActionButton
                label="Keep"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={isMutating}
              />
            </div>
          ) : (
            <EntityActionButton
              label="Delete"
              color={colors.red}
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={isMutating}
            />
          )}
          {addingTask ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!taskTitle.trim()) return;
                mutations.createEntity.mutate(
                  {
                    type: 'task',
                    title: taskTitle.trim(),
                    milestone_id: milestone.id,
                    workstream_id: milestone.workstreamId ?? undefined,
                    initiative_id: initiative.id,
                    status: 'todo',
                  },
                  {
                    onSuccess: () => {
                      setTaskTitle('');
                      setAddingTask(false);
                    },
                    onError: (error) => {
                      setNotice(error instanceof Error ? error.message : 'Failed to create task.');
                    },
                  }
                );
              }}
            >
              <input
                type="text"
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="Task title..."
                autoFocus
                className="text-body bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-primary placeholder-white/30 w-[160px] outline-none focus:border-white/25"
              />
              <EntityActionButton
                label="Add"
                color={colors.lime}
                type="submit"
                size="sm"
                disabled={!taskTitle.trim() || mutations.createEntity.isPending}
              />
              <EntityActionButton
                label="Cancel"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingTask(false);
                  setTaskTitle('');
                }}
              />
            </form>
          ) : (
            <EntityActionButton
              label="+ Task"
              variant="ghost"
              onClick={() => setAddingTask(true)}
              disabled={isMutating}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}
