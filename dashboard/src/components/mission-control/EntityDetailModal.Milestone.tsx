import { useEffect, useRef, useState } from 'react';
import { colors } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';
import type { Initiative, InitiativeMilestone } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  getMilestoneStatusClass,
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { completionPercent, isDoneStatus } from '@/lib/progress';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { EntityArtifactsPanel } from '@/components/artifacts/EntityArtifactsPanel';
import { IwmtLevelIcon, iwmtLevelCode } from './IwmtLevelIcon';

interface MilestoneDetailProps {
  milestone: InitiativeMilestone;
  initiative: Initiative;
}

export function MilestoneDetail({ milestone, initiative }: MilestoneDetailProps) {
  const { openModal, closeModal, authToken, embedMode, mutations } = useMissionControl();
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState(milestone.title);
  const [draftDescription, setDraftDescription] = useState(milestone.description ?? '');
  const [draftDueDate, setDraftDueDate] = useState(toDateInputValue(milestone.dueDate));
  const [draftStatus, setDraftStatus] = useState(milestone.status);

  // Close overflow menu on outside click or Escape
  useEffect(() => {
    if (!overflowOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [overflowOpen]);

  const { details } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });

  const associatedTasks = details.tasks.filter(
    (t) => t.milestoneId === milestone.id
  );
  const parentWorkstream = details.workstreams.find(
    (workstream) => workstream.id === milestone.workstreamId
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
  const formatNoticeError = (raw: string | undefined, fallback: string) =>
    raw && raw.trim().length > 0 ? humanizeWarning(raw.trim()) : fallback;

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
          setNotice(
            formatNoticeError(
              error instanceof Error ? error.message : '',
              'Failed to update milestone.'
            )
          );
        },
      }
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <IwmtLevelIcon level="milestone" size={16} />
          <h2 className="text-title font-semibold text-white">
            {milestone.title}
          </h2>
          <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro font-semibold uppercase tracking-[0.08em] text-white/65">
            {milestone.hierarchyLabel ?? iwmtLevelCode('milestone')}
          </span>
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

      {/* Inline metadata + progress */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-caption text-secondary">
          <span>{associatedTasks.length} {associatedTasks.length === 1 ? 'task' : 'tasks'}</span>
          <span className="text-faint">·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doneTaskCount}/{associatedTasks.length} done</span>
          {milestone.dueDate && (() => {
            const due = Date.parse(milestone.dueDate!);
            if (!Number.isFinite(due)) return null;
            const daysUntil = Math.ceil((due - Date.now()) / 86_400_000);
            const tone = daysUntil < 0 ? colors.red : daysUntil <= 3 ? colors.red : daysUntil <= 7 ? colors.amber : 'rgba(255,255,255,0.5)';
            const label = daysUntil < 0 ? `${Math.abs(daysUntil)}d overdue` : `Due in ${daysUntil}d`;
            return (
              <>
                <span className="text-faint">·</span>
                <span style={{ color: tone }}>{label}</span>
              </>
            );
          })()}
        </div>
        {associatedTasks.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(progressValue, 2)}%`, backgroundColor: colors.teal }}
              />
            </div>
            <span className="text-micro text-secondary tabular-nums">{progressValue}%</span>
          </div>
        )}
      </div>

      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">
          IWMT Composition
        </h3>
        {associatedTasks.length > 0 ? (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
            <div className="space-y-1.5">
              {associatedTasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => openModal({ type: 'task', entity: task, initiative })}
                  className="flex w-full items-center justify-between gap-2 rounded-lg bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <IwmtLevelIcon level="task" size={11} className="flex-shrink-0" />
                      <span className="text-micro uppercase tracking-[0.08em] text-white/50">
                        {task.hierarchyLabel ?? iwmtLevelCode('task')}
                      </span>
                      <span className="truncate text-caption text-bright">{task.title}</span>
                    </div>
                    {task.priority && (
                      <p className="mt-0.5 text-micro uppercase tracking-[0.08em] text-muted">
                        {task.priority}
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getTaskStatusClass(
                      task.status
                    )}`}
                  >
                    {formatEntityStatus(task.status)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.01] px-3 py-2 text-micro text-muted">
            No tasks linked to this milestone yet.
          </div>
        )}
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

      {/* Artifacts */}
      <EntityArtifactsPanel
        entityType="milestone"
        entityId={milestone.id}
        authToken={authToken}
        embedMode={embedMode}
      />

      {/* Notes — inline, always visible */}
      <div className="space-y-2">
        <EntityCommentsPanel
          entityType="milestone"
          entityId={milestone.id}
          authToken={authToken}
          embedMode={embedMode}
        />
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
          {/* Overflow menu */}
          <div className="relative" ref={overflowRef}>
            <button
              type="button"
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-secondary hover:bg-white/10 hover:text-primary transition-colors text-sm leading-none"
              onClick={() => { setOverflowOpen((v) => !v); setConfirmDelete(false); }}
              aria-label="More actions"
              disabled={isMutating}
            >
              &#x22EF;
            </button>
            {overflowOpen && (
              <div className="popover-enter absolute bottom-full right-0 mb-1 min-w-[160px] rounded-lg border border-white/10 bg-[#0c1322] shadow-xl z-50">
                {confirmDelete ? (
                  <div className="flex flex-col gap-1 p-2">
                    <span className="text-caption text-secondary px-2">Delete milestone?</span>
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-white/5 transition-colors"
                      style={{ color: colors.red }}
                      onClick={() =>
                        mutations.deleteEntity.mutate(
                          { type: 'milestone', id: milestone.id },
                          {
                            onSuccess: () => closeModal(),
                            onError: (error) =>
                              setNotice(
                                formatNoticeError(
                                  error instanceof Error ? error.message : '',
                                  'Failed to delete milestone.'
                                )
                              ),
                          }
                        )
                      }
                      disabled={isMutating}
                    >
                      Confirm Delete
                    </button>
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm text-secondary hover:bg-white/5 transition-colors"
                      onClick={() => setConfirmDelete(false)}
                      disabled={isMutating}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="p-1">
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-white/5 transition-colors"
                      style={{ color: colors.red }}
                      onClick={() => setConfirmDelete(true)}
                      disabled={isMutating}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
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
                      setNotice(
                        formatNoticeError(
                          error instanceof Error ? error.message : '',
                          'Failed to create task.'
                        )
                      );
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
