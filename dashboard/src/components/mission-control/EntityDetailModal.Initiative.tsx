import { useEffect, useState } from 'react';
import { colors } from '@/lib/tokens';
import type { Initiative } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  initiativeStatusClass,
  formatEntityStatus,
  getWorkstreamStatusClass,
} from '@/lib/entityStatusColors';
import { clampPercent, completionPercent, isDoneStatus } from '@/lib/progress';
import { Skeleton } from '@/components/shared/Skeleton';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';

interface InitiativeDetailProps {
  initiative: Initiative;
}

export function InitiativeDetail({ initiative }: InitiativeDetailProps) {
  const {
    agentEntityMap,
    openModal,
    closeModal,
    authToken,
    embedMode,
    mutations,
  } = useMissionControl();
  const agents = agentEntityMap.get(initiative.id) ?? [];
  const [addingWorkstream, setAddingWorkstream] = useState(false);
  const [wsTitle, setWsTitle] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initiative.name);
  const [draftSummary, setDraftSummary] = useState(initiative.description ?? '');
  const [draftPriority, setDraftPriority] = useState(
    normalizeInitiativePriority(initiative.priority)
  );
  const [draftTargetDate, setDraftTargetDate] = useState(
    toDateInputValue(initiative.targetDate)
  );
  const [optimisticStatus, setOptimisticStatus] = useState<Initiative['status'] | null>(null);

  const { details, isLoading } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });

  const activeTasks = details.tasks.filter((t) =>
    ['active', 'in_progress'].includes(t.status.toLowerCase())
  ).length;
  const blockedTasks = details.tasks.filter(
    (t) => t.status.toLowerCase() === 'blocked'
  ).length;
  const doneTasks = details.tasks.filter((t) => isDoneStatus(t.status)).length;
  const currentStatus = optimisticStatus ?? initiative.status;
  const currentStatusKey = normalizeInitiativeStatusKey(
    optimisticStatus ?? initiative.rawStatus ?? initiative.status
  );
  const canPause = ['active', 'in_progress', 'running', 'queued'].includes(currentStatusKey);
  const canResume = ['paused', 'draft', 'planned', 'todo', 'backlog', 'pending', 'not_started'].includes(
    currentStatusKey
  );
  const isMutating =
    mutations.entityAction.isPending ||
    mutations.createEntity.isPending ||
    mutations.updateEntity.isPending ||
    mutations.deleteEntity.isPending;

  useEffect(() => {
    if (editMode) return;
    setDraftTitle(initiative.name);
    setDraftSummary(initiative.description ?? '');
    setDraftTargetDate(toDateInputValue(initiative.targetDate));
    setDraftPriority(normalizeInitiativePriority(initiative.priority));
  }, [editMode, initiative.description, initiative.name, initiative.priority, initiative.targetDate]);

  useEffect(() => {
    setOptimisticStatus(null);
    setConfirmDelete(false);
  }, [initiative.id, initiative.status, initiative.rawStatus]);

  const runInitiativeAction = (
    action: 'pause' | 'resume',
    nextStatus: Initiative['status'],
    successMessage: string
  ) => {
    setNotice(null);
    mutations.entityAction.mutate(
      {
        type: 'initiative',
        id: initiative.id,
        action,
      },
      {
        onSuccess: () => {
          setOptimisticStatus(nextStatus);
          setNotice(successMessage);
        },
        onError: (error) => {
          setNotice(error instanceof Error ? error.message : `Failed to ${action} initiative.`);
        },
      }
    );
  };

  const handleSaveEdits = () => {
    const title = draftTitle.trim();
    if (!title) {
      setNotice('Initiative title is required.');
      return;
    }
    setNotice(null);
    mutations.updateEntity.mutate(
      {
        type: 'initiative',
        id: initiative.id,
        title,
        summary: draftSummary.trim() || null,
        priority: draftPriority,
        target_date: draftTargetDate || null,
      },
      {
        onSuccess: () => {
          setEditMode(false);
          setNotice('Initiative updated.');
        },
        onError: (error) => {
          setNotice(error instanceof Error ? error.message : 'Failed to update initiative.');
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
          <EntityIcon type="initiative" size={16} />
          <h2 className="text-title font-semibold text-white">
            {initiative.name}
          </h2>
          <span
            className={`text-micro px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${initiativeStatusClass[currentStatus] ?? initiativeStatusClass.active}`}
          >
            {formatEntityStatus(currentStatus)}
          </span>
          <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-white/68">
            {formatPriorityLabel(initiative.priority)}
          </span>
        </div>
        {editMode ? (
          <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">
                Title
              </span>
              <input
                type="text"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">
                Summary
              </span>
              <textarea
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">
                Target date
              </span>
              <input
                type="date"
                value={draftTargetDate}
                onChange={(event) => setDraftTargetDate(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">
                Priority
              </span>
              <select
                value={draftPriority}
                onChange={(event) => setDraftPriority(normalizeInitiativePriority(event.target.value))}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              >
                <option value="critical">Critical (P0)</option>
                <option value="high">High (P1)</option>
                <option value="medium">Medium (P2)</option>
                <option value="low">Low (P3)</option>
              </select>
            </label>
          </div>
        ) : initiative.description ? (
          <p className="text-body text-secondary leading-relaxed">
            {initiative.description}
          </p>
        ) : (
          <p className="text-body text-muted">No summary yet.</p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-micro text-muted uppercase tracking-wider">
              Agents
            </span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
        {notice && (
          <div className="text-caption text-secondary">
            {notice}
          </div>
        )}
        </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricBox label="Workstreams" value={`${details.workstreams.length}`} />
        <MetricBox label="Milestones" value={`${details.milestones.length}`} />
        <MetricBox label="Active Tasks" value={`${activeTasks}`} accent={activeTasks > 0 ? colors.lime : undefined} />
        <MetricBox label="Blocked" value={`${blockedTasks}`} accent={blockedTasks > 0 ? colors.red : undefined} />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`init-detail-${i}`} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Workstreams */}
          {details.workstreams.length > 0 && (
            <div className="space-y-2">
              <SectionLabel title="Workstreams" count={details.workstreams.length} />
              {details.workstreams.map((ws) => {
                const wsTasks = details.tasks.filter((t) => t.workstreamId === ws.id);
                const doneWsTasks = wsTasks.filter((t) => isDoneStatus(t.status)).length;
                const completion =
                  wsTasks.length > 0
                    ? completionPercent(doneWsTasks, wsTasks.length)
                    : typeof ws.progress === 'number'
                      ? clampPercent(ws.progress <= 1 ? ws.progress * 100 : ws.progress)
                      : isDoneStatus(ws.status)
                        ? 100
                        : null;
                return (
                  <button
                    key={ws.id}
                    onClick={() =>
                      openModal({
                        type: 'workstream',
                        entity: ws,
                        initiative,
                      })
                    }
                    className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5 transition-colors hover:bg-white/[0.06]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-body text-bright break-words">
                        {ws.name}
                      </span>
                      <span
                        className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(ws.status)}`}
                      >
                        {formatEntityStatus(ws.status)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-micro text-muted uppercase tracking-[0.08em]">
                      <span>{wsTasks.length} tasks</span>
                      {completion !== null && <span>{completion}%</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Milestones */}
          {details.milestones.length > 0 && (
            <div className="space-y-2">
              <SectionLabel title="Milestones" count={details.milestones.length} />
              {details.milestones.map((ms) => (
                <button
                  key={ms.id}
                  onClick={() =>
                    openModal({ type: 'milestone', entity: ms, initiative })
                  }
                  className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.06]"
                >
                  <div className="flex items-center gap-2">
                      <span className="text-body text-bright break-words">
                        {ms.title}
                      </span>
                    <span className="text-micro text-muted uppercase tracking-[0.08em]">
                      {formatEntityStatus(ms.status)}
                    </span>
                  </div>
                  {ms.dueDate && (
                    <span className="text-micro text-muted mt-0.5 block">
                      Due: {new Date(ms.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Summary */}
          <div className="text-micro uppercase tracking-[0.08em] text-muted pt-2 border-t border-subtle">
            {details.tasks.length} total tasks &middot; {doneTasks} done
          </div>

          {/* Notes */}
          <div className="mt-4 space-y-2 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-micro font-semibold uppercase tracking-[0.14em] text-muted">
                  Notes
                </p>
                <p className="mt-1 text-caption text-muted">
                  Lightweight context for humans and agents on this initiative.
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
                  entityType="initiative"
                  entityId={initiative.id}
                  authToken={authToken}
                  embedMode={embedMode}
                />
              </div>
            ) : null}
          </div>
        </>
      )}
      </div>

      {/* Actions */}
      <div className="border-t border-subtle bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {canPause && (
            <EntityActionButton
              label="Pause"
              color={colors.amber}
              onClick={() => runInitiativeAction('pause', 'paused', 'Initiative paused.')}
              disabled={isMutating}
            />
          )}
          {canResume && (
            <EntityActionButton
              label={currentStatusKey === 'paused' ? 'Resume' : 'Start'}
              color={colors.lime}
              variant="primary"
              onClick={() =>
                runInitiativeAction(
                  'resume',
                  'active',
                  currentStatusKey === 'paused' ? 'Initiative resumed.' : 'Initiative started.'
                )
              }
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
                  setDraftTitle(initiative.name);
                  setDraftSummary(initiative.description ?? '');
                  setDraftPriority(normalizeInitiativePriority(initiative.priority));
                  setDraftTargetDate(toDateInputValue(initiative.targetDate));
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
              <span className="text-caption text-secondary">Delete initiative?</span>
              <EntityActionButton
                label="Delete"
                color={colors.red}
                variant="destructive"
                onClick={() =>
                  mutations.deleteEntity.mutate(
                    { type: 'initiative', id: initiative.id },
                    {
                      onSuccess: () => closeModal(),
                      onError: (error) =>
                        setNotice(
                          error instanceof Error
                            ? error.message
                            : 'Failed to delete initiative.'
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
          {addingWorkstream ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!wsTitle.trim()) return;
                mutations.createEntity.mutate(
                  { type: 'workstream', title: wsTitle.trim(), initiative_id: initiative.id, status: 'not_started' },
                  { onSuccess: () => { setWsTitle(''); setAddingWorkstream(false); } },
                );
              }}
            >
              <input
                type="text"
                value={wsTitle}
                onChange={(e) => setWsTitle(e.target.value)}
                placeholder="Workstream name..."
                autoFocus
                className="text-body bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-primary placeholder-white/30 w-[180px] outline-none focus:border-white/25"
              />
              <EntityActionButton
                type="submit"
                label="Add"
                color={colors.lime}
                disabled={!wsTitle.trim() || mutations.createEntity.isPending}
                size="sm"
              />
              <EntityActionButton
                label="Cancel"
                variant="ghost"
                onClick={() => { setAddingWorkstream(false); setWsTitle(''); }}
                size="sm"
              />
            </form>
          ) : (
            <EntityActionButton
              label="+ Workstream"
              variant="ghost"
              onClick={() => setAddingWorkstream(true)}
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

function normalizeInitiativeStatusKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeInitiativePriority(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'p0' || normalized === 'urgent') return 'critical';
  if (normalized === 'high' || normalized === 'p1') return 'high';
  if (normalized === 'medium' || normalized === 'normal' || normalized === 'p2') return 'medium';
  if (normalized === 'low' || normalized === 'p3') return 'low';
  return 'medium';
}

function formatPriorityLabel(value: string | null | undefined): string {
  const priority = normalizeInitiativePriority(value);
  if (priority === 'critical') return 'Priority: Critical';
  if (priority === 'high') return 'Priority: High';
  if (priority === 'low') return 'Priority: Low';
  return 'Priority: Medium';
}

function MetricBox({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5"
      style={accent ? { borderTopColor: `${accent}50`, borderTopWidth: 2 } : undefined}
    >
      <div className="text-micro uppercase tracking-[0.08em] text-muted">
        {label}
      </div>
      <div
        className="text-heading font-medium mt-0.5"
        style={{ color: accent ?? 'rgba(255,255,255,0.8)' }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-caption uppercase tracking-[0.08em] text-muted">
        {title}
      </span>
      <span className="text-micro text-muted">{count}</span>
    </div>
  );
}
