import { useState } from 'react';
import { colors } from '@/lib/tokens';
import type { Initiative } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  initiativeStatusClass,
  formatEntityStatus,
  getWorkstreamStatusClass,
} from '@/lib/entityStatusColors';
import { Skeleton } from '@/components/shared/Skeleton';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';

interface InitiativeDetailProps {
  initiative: Initiative;
}

export function InitiativeDetail({ initiative }: InitiativeDetailProps) {
  const { agentEntityMap, openModal, authToken, embedMode, mutations } = useMissionControl();
  const agents = agentEntityMap.get(initiative.id) ?? [];
  const [addingWorkstream, setAddingWorkstream] = useState(false);
  const [wsTitle, setWsTitle] = useState('');

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
  const doneTasks = details.tasks.filter((t) =>
    ['done', 'completed'].includes(t.status.toLowerCase())
  ).length;

  return (
    <div className="p-6 space-y-5">
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
        {initiative.description && (
          <p className="text-[13px] text-white/50 leading-relaxed">
            {initiative.description}
          </p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">
              Agents
            </span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3">
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
                const taskCount = details.tasks.filter(
                  (t) => t.workstreamId === ws.id
                ).length;
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
                    className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5 transition-all hover:bg-white/[0.06] hover-lift"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-white/90 truncate">
                        {ws.name}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(ws.status)}`}
                      >
                        {formatEntityStatus(ws.status)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-white/35 uppercase tracking-[0.08em]">
                      <span>{taskCount} tasks</span>
                      {ws.progress !== null && (
                        <span>{Math.round(ws.progress)}%</span>
                      )}
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
                  className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-all hover:bg-white/[0.06] hover-lift"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-white/90 truncate">
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

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
            {initiative.status === 'active' && (
              <button
                onClick={() => mutations.entityAction.mutate({ type: 'initiative', id: initiative.id, action: 'pause' })}
                disabled={mutations.entityAction.isPending}
                className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: `${colors.amber}20`,
                  color: colors.amber,
                  borderColor: `${colors.amber}30`,
                }}
              >
                Pause
              </button>
            )}
            {initiative.status === 'paused' && (
              <button
                onClick={() => mutations.entityAction.mutate({ type: 'initiative', id: initiative.id, action: 'resume' })}
                disabled={mutations.entityAction.isPending}
                className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: `${colors.lime}20`,
                  color: colors.lime,
                  borderColor: `${colors.lime}30`,
                }}
              >
                Resume
              </button>
            )}
            <div className="flex-1" />
            {addingWorkstream ? (
              <form
                className="flex items-center gap-2"
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
                <button
                  type="submit"
                  disabled={!wsTitle.trim() || mutations.createEntity.isPending}
                  className="text-[11px] px-2.5 py-1 rounded-lg border disabled:opacity-50"
                  style={{ backgroundColor: `${colors.lime}20`, color: colors.lime, borderColor: `${colors.lime}30` }}
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => { setAddingWorkstream(false); setWsTitle(''); }}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/40 border border-white/10"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                onClick={() => setAddingWorkstream(true)}
                className="text-[11px] px-3 py-1.5 rounded-lg border bg-white/5 text-white/50 border-white/10 hover:bg-white/10 transition-colors"
              >
                + Workstream
              </button>
            )}
          </div>

          {/* Summary */}
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/30 pt-2 border-t border-white/[0.06]">
            {details.tasks.length} total tasks &middot; {doneTasks} done
          </div>
        </>
      )}
    </div>
  );
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
