import { useEffect, useMemo, useRef, useState } from 'react';
import { colors } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';
import { formatRelativeTime } from '@/lib/time';
import type { Initiative } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import {
  initiativeStatusClass,
  formatEntityStatus,
  getWorkstreamStatusClass,
  getMilestoneStatusClass,
} from '@/lib/entityStatusColors';
import { clampPercent, completionPercent, isDoneStatus } from '@/lib/progress';
import { Skeleton } from '@/components/shared/Skeleton';
import { ProgressRing } from '@/components/shared/ProgressRing';
import { MetricRow } from '@/components/shared/MetricRow';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { EntityArtifactsPanel } from '@/components/artifacts/EntityArtifactsPanel';
import { QueuePlacementControl } from './QueuePlacementControl';
import { IwmtLevelIcon, iwmtLevelCode } from './IwmtLevelIcon';

interface InitiativeDetailProps {
  initiative: Initiative;
}

type QueuePlacement = 'top' | 'bottom';

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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const nextUpActions = useNextUpQueueActions({ authToken, embedMode });

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
  const queueActionBusy = nextUpActions.isPinning || nextUpActions.isMoving;
  const queueTargets = useMemo(() => {
    if (details.workstreams.length > 0) {
      return details.workstreams.map((workstream) => ({
        id: workstream.id,
        name: workstream.name,
      }));
    }
    return (initiative.workstreams ?? []).map((workstream) => ({
      id: workstream.id,
      name: workstream.name,
    }));
  }, [details.workstreams, initiative.workstreams]);
  const milestonesByWorkstream = useMemo(() => {
    const grouped = new Map<string, typeof details.milestones>();
    const unscoped: typeof details.milestones = [];
    for (const milestone of details.milestones) {
      if (!milestone.workstreamId) {
        unscoped.push(milestone);
        continue;
      }
      const current = grouped.get(milestone.workstreamId);
      if (current) {
        current.push(milestone);
      } else {
        grouped.set(milestone.workstreamId, [milestone]);
      }
    }
    return { grouped, unscoped };
  }, [details.milestones]);
  const tasksByWorkstream = useMemo(() => {
    const grouped = new Map<string, typeof details.tasks>();
    for (const task of details.tasks) {
      if (!task.workstreamId) continue;
      const current = grouped.get(task.workstreamId);
      if (current) {
        current.push(task);
      } else {
        grouped.set(task.workstreamId, [task]);
      }
    }
    return grouped;
  }, [details.tasks]);
  const tasksByMilestone = useMemo(() => {
    const grouped = new Map<string, typeof details.tasks>();
    for (const task of details.tasks) {
      if (!task.milestoneId) continue;
      const current = grouped.get(task.milestoneId);
      if (current) {
        current.push(task);
      } else {
        grouped.set(task.milestoneId, [task]);
      }
    }
    return grouped;
  }, [details.tasks]);
  const orphanTasks = useMemo(
    () => details.tasks.filter((task) => !task.workstreamId && !task.milestoneId),
    [details.tasks]
  );
  const formatNoticeError = (raw: string | undefined, fallback: string) =>
    raw && raw.trim().length > 0 ? humanizeWarning(raw.trim()) : fallback;

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
          setNotice(
            formatNoticeError(
              error instanceof Error ? error.message : '',
              `Failed to ${action} initiative.`
            )
          );
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
          setNotice(
            formatNoticeError(
              error instanceof Error ? error.message : '',
              'Failed to update initiative.'
            )
          );
        },
      }
    );
  };

  const queueInitiative = async (placement: QueuePlacement) => {
    if (queueTargets.length === 0) {
      setNotice('No workstreams available to queue.');
      return;
    }

    const orderedTargets =
      placement === 'top' ? [...queueTargets].reverse() : queueTargets;
    let queuedCount = 0;
    let failedCount = 0;
    let firstError: string | null = null;

    for (const target of orderedTargets) {
      try {
        await nextUpActions.pin({
          initiativeId: initiative.id,
          workstreamId: target.id,
        });
        await nextUpActions.move({
          initiativeId: initiative.id,
          workstreamId: target.id,
          placement,
        });
        queuedCount += 1;
      } catch (error) {
        failedCount += 1;
        if (!firstError) {
          firstError = formatNoticeError(
            error instanceof Error ? error.message : '',
            'Failed to queue initiative workstream.'
          );
        }
      }
    }

    if (failedCount > 0) {
      setNotice(
        queuedCount > 0
          ? `Queued ${queuedCount}/${queueTargets.length} workstreams (${failedCount} failed).`
          : firstError ?? 'Failed to queue initiative workstreams.'
      );
      return;
    }

    setNotice(
      `Queued ${queuedCount} workstream${queuedCount === 1 ? '' : 's'} to ${
        placement === 'top' ? 'top' : 'end'
      }.`
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Hero */}
        <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <IwmtLevelIcon level="initiative" size={16} />
              <h2 className="text-[28px] font-medium leading-none text-white truncate">
                {initiative.name}
              </h2>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${initiativeStatusClass[currentStatus] ?? initiativeStatusClass.active}`}
              >
                {formatEntityStatus(currentStatus)}
              </span>
              <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-white/68">
                {formatPriorityLabel(initiative.priority)}
              </span>
            </div>
          </div>
          {(() => {
            const totalTasks = details.tasks.length || 0;
            const progress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
            return totalTasks > 0 ? <ProgressRing percent={progress} size={56} /> : null;
          })()}
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

      {/* Metrics row */}
      <MetricRow
        metrics={[
          { label: 'Done', value: doneTasks, color: colors.teal },
          { label: 'Active', value: activeTasks, color: colors.lime },
          { label: 'Blocked', value: blockedTasks, color: colors.red },
          ...(initiative.targetDate
            ? [{ label: 'ETA', value: formatRelativeEta(initiative.targetDate) }]
            : []),
        ]}
        className="pt-2 pb-4 border-b border-white/[0.04]"
      />

      {/* Progress bar */}
      {details.tasks.length > 0 && (() => {
        const totalTasks = details.tasks.length;
        const overallProgress = Math.round((doneTasks / totalTasks) * 100);
        return (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(overallProgress, 2)}%`, background: `linear-gradient(90deg, ${colors.teal}, ${colors.lime})` }}
              />
            </div>
            <span className="text-micro text-secondary tabular-nums">{overallProgress}%</span>
          </div>
        );
      })()}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`init-detail-${i}`} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {(details.workstreams.length > 0 ||
            details.milestones.length > 0 ||
            orphanTasks.length > 0) && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">
                  IWMT Composition
                </h3>
                <p className="text-micro text-muted">
                  {details.workstreams.length} workstreams · {details.milestones.length} milestones ·{' '}
                  {details.tasks.length} tasks
                </p>
              </div>

              <div className="space-y-2.5">
                {details.workstreams.map((ws) => {
                  const wsMilestones = milestonesByWorkstream.grouped.get(ws.id) ?? [];
                  const wsTasks = tasksByWorkstream.get(ws.id) ?? [];
                  const doneWsTasks = wsTasks.filter((task) => isDoneStatus(task.status)).length;
                  const completion =
                    wsTasks.length > 0
                      ? completionPercent(doneWsTasks, wsTasks.length)
                      : typeof ws.progress === 'number'
                        ? clampPercent(
                            ws.progress <= 1 ? ws.progress * 100 : ws.progress
                          )
                        : isDoneStatus(ws.status)
                          ? 100
                          : 0;
                  const wsStatus = ws.status.toLowerCase();
                  const wsCanQueue = !['done', 'completed', 'archived'].includes(wsStatus);
                  const wsLabel = ws.hierarchyLabel ?? iwmtLevelCode('workstream');

                  return (
                    <article
                      key={ws.id}
                      className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          onClick={() =>
                            openModal({
                              type: 'workstream',
                              entity: ws,
                              initiative,
                            })
                          }
                          className="group min-w-0 flex-1 text-left"
                        >
                          <div className="flex min-w-0 items-start gap-2.5">
                            <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.04]">
                              <IwmtLevelIcon level="workstream" size={12} />
                            </span>
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="text-micro font-semibold uppercase tracking-[0.08em] text-white/58">
                                  {wsLabel}
                                </span>
                                <span className="truncate text-body text-bright">
                                  {ws.name}
                                </span>
                              </div>
                              <p className="mt-0.5 text-caption text-muted">
                                {wsMilestones.length} milestone{wsMilestones.length === 1 ? '' : 's'} ·{' '}
                                {wsTasks.length} task{wsTasks.length === 1 ? '' : 's'} · {completion}% done
                              </p>
                            </div>
                          </div>
                        </button>
                        <div className="flex items-center gap-1.5">
                          {wsCanQueue && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md border border-white/[0.12] bg-white/[0.05] px-1.5 py-0.5 text-micro text-white/70 transition-colors hover:bg-white/[0.1] hover:text-white"
                              onClick={async (event) => {
                                event.stopPropagation();
                                setNotice(null);
                                try {
                                  await nextUpActions.pin({
                                    initiativeId: initiative.id,
                                    workstreamId: ws.id,
                                  });
                                  await nextUpActions.move({
                                    initiativeId: initiative.id,
                                    workstreamId: ws.id,
                                    placement: 'bottom',
                                  });
                                  setNotice(`Queued "${ws.name}" to end.`);
                                } catch (error) {
                                  setNotice(
                                    formatNoticeError(
                                      error instanceof Error ? error.message : '',
                                      'Failed to queue workstream.'
                                    )
                                  );
                                }
                              }}
                            >
                              Queue
                            </button>
                          )}
                          <span
                            className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(
                              ws.status
                            )}`}
                          >
                            {formatEntityStatus(ws.status)}
                          </span>
                        </div>
                      </div>

                      {wsMilestones.length > 0 ? (
                        <div className="ml-7 mt-2.5 space-y-1.5 border-l border-white/[0.08] pl-3">
                          {wsMilestones.map((milestone) => {
                            const milestoneTasks = tasksByMilestone.get(milestone.id) ?? [];
                            const doneMilestoneTasks = milestoneTasks.filter((task) =>
                              isDoneStatus(task.status)
                            ).length;
                            const milestoneLabel =
                              milestone.hierarchyLabel ?? iwmtLevelCode('milestone');

                            return (
                              <button
                                key={milestone.id}
                                onClick={() =>
                                  openModal({
                                    type: 'milestone',
                                    entity: milestone,
                                    initiative,
                                  })
                                }
                                className="flex w-full items-center justify-between gap-2 rounded-lg bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                              >
                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <IwmtLevelIcon level="milestone" size={11} className="flex-shrink-0" />
                                    <span className="text-micro uppercase tracking-[0.08em] text-white/52">
                                      {milestoneLabel}
                                    </span>
                                    <span className="truncate text-caption text-bright">
                                      {milestone.title}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-micro text-muted">
                                    {doneMilestoneTasks}/{milestoneTasks.length} tasks done
                                  </p>
                                </div>
                                <span
                                  className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(
                                    milestone.status
                                  )}`}
                                >
                                  {formatEntityStatus(milestone.status)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="ml-7 mt-2 rounded-lg border border-dashed border-white/[0.1] bg-white/[0.01] px-3 py-2 text-micro text-muted">
                          No milestones yet.
                        </div>
                      )}
                    </article>
                  );
                })}

                {milestonesByWorkstream.unscoped.length > 0 && (
                  <article className="rounded-xl border border-white/[0.08] bg-white/[0.015] px-3 py-2.5">
                    <p className="text-micro uppercase tracking-[0.1em] text-white/50">
                      Unscoped milestones
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {milestonesByWorkstream.unscoped.map((milestone) => (
                        <button
                          key={milestone.id}
                          onClick={() =>
                            openModal({
                              type: 'milestone',
                              entity: milestone,
                              initiative,
                            })
                          }
                          className="flex w-full items-center justify-between gap-2 rounded-lg bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <IwmtLevelIcon level="milestone" size={11} className="flex-shrink-0" />
                              <span className="text-micro uppercase tracking-[0.08em] text-white/52">
                                {milestone.hierarchyLabel ?? iwmtLevelCode('milestone')}
                              </span>
                              <span className="truncate text-caption text-bright">
                                {milestone.title}
                              </span>
                            </div>
                          </div>
                          <span
                            className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(
                              milestone.status
                            )}`}
                          >
                            {formatEntityStatus(milestone.status)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </article>
                )}

                {orphanTasks.length > 0 && (
                  <article className="rounded-xl border border-white/[0.08] bg-white/[0.015] px-3 py-2.5">
                    <p className="text-micro uppercase tracking-[0.1em] text-white/50">
                      Unscoped tasks
                    </p>
                    <p className="mt-1 text-caption text-muted">
                      {orphanTasks.length} task{orphanTasks.length === 1 ? '' : 's'} without a workstream or milestone.
                    </p>
                  </article>
                )}
              </div>
            </section>
          )}

          <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

          {/* Artifacts */}
          <EntityArtifactsPanel
            entityType="initiative"
            entityId={initiative.id}
            authToken={authToken}
            embedMode={embedMode}
          />

          {/* Notes — inline, always visible */}
          <div className="space-y-2">
            <EntityCommentsPanel
              entityType="initiative"
              entityId={initiative.id}
              authToken={authToken}
              embedMode={embedMode}
            />
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
          <QueuePlacementControl
            label="Queue"
            size="md"
            busy={queueActionBusy}
            disabled={isMutating || queueTargets.length === 0}
            title={`Queue initiative: ${initiative.name}`}
            onSelectPlacement={queueInitiative}
          />
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
                    <span className="text-caption text-secondary px-2">Delete initiative?</span>
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-white/5 transition-colors"
                      style={{ color: colors.red }}
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

function formatRelativeEta(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return formatRelativeTime(dateStr);
}
