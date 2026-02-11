import { useState } from 'react';
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
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';

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
  const [draftTitle, setDraftTitle] = useState(initiative.name);
  const [draftSummary, setDraftSummary] = useState(initiative.description ?? '');
  const [draftTargetDate, setDraftTargetDate] = useState(
    toDateInputValue(initiative.targetDate)
  );

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
  const isMutating =
    mutations.entityAction.isPending ||
    mutations.createEntity.isPending ||
    mutations.updateEntity.isPending ||
    mutations.deleteEntity.isPending;

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
          <h2 className="text-[16px] font-semibold text-white">
            {initiative.name}
          </h2>
          <span
            className={`text-[10px] px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${initiativeStatusClass[initiative.status]}`}
          >
            {formatEntityStatus(initiative.status)}
          </span>
        </div>
        {editMode ? (
          <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">
                Title
              </span>
              <input
                type="text"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">
                Summary
              </span>
              <textarea
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">
                Target date
              </span>
              <input
                type="date"
                value={draftTargetDate}
                onChange={(event) => setDraftTargetDate(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              />
            </label>
          </div>
        ) : initiative.description ? (
          <p className="text-[13px] text-white/50 leading-relaxed">
            {initiative.description}
          </p>
        ) : (
          <p className="text-[12px] text-white/35">No summary yet.</p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">
              Agents
            </span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
        {notice && (
          <div className="text-[11px] text-white/55">
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
                      <span className="text-[12px] text-white/90 break-words">
                        {ws.name}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(ws.status)}`}
                      >
                        {formatEntityStatus(ws.status)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-white/35 uppercase tracking-[0.08em]">
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
                      <span className="text-[12px] text-white/90 break-words">
                        {ms.title}
                      </span>
                    <span className="text-[10px] text-white/40 uppercase tracking-[0.08em]">
                      {formatEntityStatus(ms.status)}
                    </span>
                  </div>
                  {ms.dueDate && (
                    <span className="text-[10px] text-white/30 mt-0.5 block">
                      Due: {new Date(ms.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Summary */}
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/30 pt-2 border-t border-white/[0.06]">
            {details.tasks.length} total tasks &middot; {doneTasks} done
          </div>
        </>
      )}
      </div>

      {/* Actions */}
      <div className="border-t border-white/[0.06] bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {initiative.status === 'active' && (
            <EntityActionButton
              label="Pause"
              color={colors.amber}
              onClick={() =>
                mutations.entityAction.mutate({
                  type: 'initiative',
                  id: initiative.id,
                  action: 'pause',
                })
              }
              disabled={isMutating}
            />
          )}
          {initiative.status === 'paused' && (
            <EntityActionButton
              label="Resume"
              color={colors.lime}
              variant="primary"
              onClick={() =>
                mutations.entityAction.mutate({
                  type: 'initiative',
                  id: initiative.id,
                  action: 'resume',
                })
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
              <span className="text-[11px] text-white/60">Delete initiative?</span>
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
                className="text-[12px] bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/80 placeholder-white/30 w-[180px] outline-none focus:border-white/25"
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
      <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">
        {label}
      </div>
      <div
        className="text-[15px] font-medium mt-0.5"
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
      <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">
        {title}
      </span>
      <span className="text-[10px] text-white/30">{count}</span>
    </div>
  );
}
