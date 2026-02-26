import { useState, useMemo } from 'react';
import { colors, stateTones } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';
import type { Initiative, InitiativeTask } from '@/types';
import {
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { EntityArtifactsPanel } from '@/components/artifacts/EntityArtifactsPanel';

interface TaskDetailProps {
  task: InitiativeTask;
  initiative: Initiative;
}

function dueDateLabel(dueDate: string | null | undefined): { text: string; tone: string } | null {
  if (!dueDate) return null;
  const due = Date.parse(dueDate);
  if (!Number.isFinite(due)) return null;
  const now = Date.now();
  const daysUntil = Math.ceil((due - now) / 86_400_000);
  if (daysUntil < 0) return { text: `${Math.abs(daysUntil)}d overdue`, tone: colors.red };
  if (daysUntil <= 3) return { text: `Due in ${daysUntil}d`, tone: colors.red };
  if (daysUntil <= 7) return { text: `Due in ${daysUntil}d`, tone: colors.amber };
  return { text: `Due ${new Date(due).toLocaleDateString()}`, tone: 'rgba(255,255,255,0.5)' };
}

function statusDotColor(status: string): string {
  const s = status.toLowerCase();
  if (['active', 'in_progress', 'running'].includes(s)) return stateTones.active.text;
  if (['done', 'completed'].includes(s)) return stateTones.done.text;
  if (s === 'blocked') return stateTones.blocked.text;
  return stateTones.planned.text;
}

export function TaskDetail({ task, initiative }: TaskDetailProps) {
  const { agentEntityMap, openModal, mutations, closeModal, authToken, embedMode } = useMissionControl();
  const agents = agentEntityMap.get(task.id) ?? agentEntityMap.get(initiative.id) ?? [];
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDescription, setDraftDescription] = useState(task.description ?? '');
  const [draftPriority, setDraftPriority] = useState(task.priority ?? '');
  const [draftDueDate, setDraftDueDate] = useState(toDateInputValue(task.dueDate));
  const [draftStatus, setDraftStatus] = useState(task.status);

  const status = task.status.toLowerCase();
  const dueInfo = useMemo(() => dueDateLabel(task.dueDate), [task.dueDate]);
  const formatNoticeError = (raw: string | undefined, fallback: string) =>
    raw && raw.trim().length > 0 ? humanizeWarning(raw.trim()) : fallback;

  const isMutating =
    mutations.entityAction.isPending ||
    mutations.updateEntity.isPending ||
    mutations.deleteEntity.isPending;

  const handleAction = (action: string) => {
    setNotice(null);
    mutations.entityAction.mutate(
      { type: 'task', id: task.id, action },
      {
        onError: (error) => {
          setNotice(
            formatNoticeError(error instanceof Error ? error.message : '', 'Task action failed.')
          );
        },
      },
    );
  };

  const handleSaveEdits = () => {
    const title = draftTitle.trim();
    if (!title) {
      setNotice('Task title is required.');
      return;
    }

    setNotice(null);
    mutations.updateEntity.mutate(
      {
        type: 'task',
        id: task.id,
        title,
        description: draftDescription.trim() || null,
        priority: draftPriority.trim() || null,
        due_date: draftDueDate || null,
        status: draftStatus,
      },
      {
        onSuccess: () => {
          setEditMode(false);
          setNotice('Task updated.');
        },
        onError: (error) => {
          setNotice(
            formatNoticeError(error instanceof Error ? error.message : '', 'Failed to update task.')
          );
        },
      },
    );
  };

  const handleDelete = () => {
    setNotice(null);
    mutations.deleteEntity.mutate(
      { type: 'task', id: task.id },
      {
        onSuccess: () => closeModal(),
        onError: (error) => {
          setNotice(
            formatNoticeError(error instanceof Error ? error.message : '', 'Failed to delete task.')
          );
        },
      },
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
          <EntityIcon type="task" size={12} className="flex-shrink-0 opacity-95" />
          <span className="break-words font-medium text-primary">{task.title}</span>
        </div>

        {/* Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <EntityIcon type="task" size={16} />
            <h2 className="break-words text-title font-semibold text-white">{task.title}</h2>
          </div>

          {/* Inline metadata sentence */}
          <div className="flex flex-wrap items-center gap-2 text-caption text-secondary">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: statusDotColor(task.status) }}
              />
              {formatEntityStatus(task.status)}
            </span>
            {task.priority && (
              <>
                <span className="text-faint">·</span>
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider text-secondary">
                  {task.priority}
                </span>
              </>
            )}
            {dueInfo && (
              <>
                <span className="text-faint">·</span>
                <span style={{ color: dueInfo.tone }}>{dueInfo.text}</span>
              </>
            )}
          </div>

          {editMode ? (
            <div className="space-y-2 pt-2">
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
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="text-micro uppercase tracking-[0.08em] text-muted">Priority</span>
                  <input
                    type="text"
                    value={draftPriority}
                    onChange={(event) => setDraftPriority(event.target.value)}
                    placeholder="p1, high, p50"
                    className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
                  />
                </label>
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
                    {['not_started', 'planned', 'todo', 'in_progress', 'active', 'blocked', 'done'].map((value) => (
                      <option key={value} value={value}>
                        {formatEntityStatus(value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : task.description ? (
            <MarkdownText
              text={task.description}
              mode="block"
              className="text-body text-secondary leading-relaxed"
            />
          ) : (
            <p className="text-body text-muted">No description yet.</p>
          )}

          {agents.length > 0 && (
            <div className="flex items-center gap-2">
              <InferredAgentAvatars agents={agents} max={4} />
            </div>
          )}
        </div>

        {notice && (
          <div className="text-caption px-1" style={{ color: `${colors.red}b3` }}>
            {notice}
          </div>
        )}

        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        {/* Artifacts */}
        <EntityArtifactsPanel
          entityType="task"
          entityId={task.id}
          authToken={authToken}
          embedMode={embedMode}
        />

        {/* Notes — inline, always visible */}
        <div className="space-y-2">
          <EntityCommentsPanel
            entityType="task"
            entityId={task.id}
            authToken={authToken}
            embedMode={embedMode}
            variant="inline"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="border-t border-subtle bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {status === 'todo' && (
            <EntityActionButton label="Start" color={colors.lime} variant="primary" onClick={() => handleAction('start')} disabled={isMutating} />
          )}
          {(status === 'in_progress' || status === 'active') && (
            <EntityActionButton label="Complete" color={colors.teal} variant="primary" onClick={() => handleAction('complete')} disabled={isMutating} />
          )}
          {(status === 'todo' || status === 'in_progress' || status === 'active') && (
            <EntityActionButton label="Block" color={colors.red} variant="destructive" onClick={() => handleAction('block')} disabled={isMutating} />
          )}
          {status === 'blocked' && (
            <EntityActionButton label="Unblock" color={colors.amber} onClick={() => handleAction('unblock')} disabled={isMutating} />
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
                  setNotice(null);
                  setDraftTitle(task.title);
                  setDraftDescription(task.description ?? '');
                  setDraftPriority(task.priority ?? '');
                  setDraftDueDate(toDateInputValue(task.dueDate));
                  setDraftStatus(task.status);
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
              <span className="text-caption" style={{ color: `${colors.red}b3` }}>Delete?</span>
              <EntityActionButton label="Delete" color={colors.red} variant="destructive" onClick={handleDelete} disabled={isMutating} />
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
