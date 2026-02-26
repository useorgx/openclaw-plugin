import { useState } from 'react';
import { motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
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
            <div className="relative flex items-center justify-center">
              <EntityIcon type="task" size={16} className={(status === 'done' || status === 'completed') ? 'opacity-0' : ''} />
              {(status === 'done' || status === 'completed') && (
                <svg className="absolute inset-0 w-4 h-4 text-lime-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <motion.polyline 
                    points="20 6 9 17 4 12"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                  />
                </svg>
              )}
            </div>
            <h2 className="break-words text-title font-semibold text-white">{task.title}</h2>
            <span
              className={`text-micro px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getTaskStatusClass(task.status)}`}
            >
              {formatEntityStatus(task.status)}
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
              <span className="text-micro text-muted uppercase tracking-wider">Agents</span>
              <InferredAgentAvatars agents={agents} max={4} />
              {(status === 'running' || status === 'in_progress') && (
                <span className="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-lime-400/10 border border-lime-400/20 text-lime-400 text-micro font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-[pulse_1s_ease-in-out_infinite]" />
                  Live Session
                </span>
              )}
            </div>
          )}
        </div>

        {/* Details Sentence */}
        <div className="text-body text-secondary bg-white/[0.02] border border-white/[0.04] p-3.5 rounded-xl leading-relaxed">
          This task is currently <span className={`font-semibold ${getTaskStatusClass(task.status)}`}>{formatEntityStatus(task.status).toLowerCase()}</span>, 
          has a priority of <span className="text-primary font-medium">{task.priority ?? 'none'}</span>, 
          and is {task.dueDate ? `due on ` : 'not scheduled with a due date.'}
          {task.dueDate && <span className="text-primary font-medium">{new Date(task.dueDate).toLocaleDateString()}</span>}{task.dueDate && '.'}
        </div>

        {notice && (
          <div className="text-caption px-1" style={{ color: `${colors.red}b3` }}>
            {notice}
          </div>
        )}

        {/* Notes & Artifacts */}
        <div className="mt-4 space-y-4">
          <EntityArtifactsPanel
            entityType="task"
            entityId={task.id}
            authToken={authToken}
            embedMode={embedMode}
          />

          <div className="space-y-3">
            <div>
              <p className="text-micro font-semibold uppercase tracking-[0.14em] text-muted">
                Notes
              </p>
              <p className="mt-1 text-caption text-muted">
                Commentary thread for humans and agents on this task.
              </p>
            </div>
            
            <EntityCommentsPanel
              entityType="task"
              entityId={task.id}
              authToken={authToken}
              embedMode={embedMode}
            />
          </div>
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
