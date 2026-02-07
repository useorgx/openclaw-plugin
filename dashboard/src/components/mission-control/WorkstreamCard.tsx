import { motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
import type { InitiativeWorkstream, InitiativeTask, Initiative } from '@/types';
import {
  getWorkstreamStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';

interface WorkstreamCardProps {
  workstream: InitiativeWorkstream;
  tasks: InitiativeTask[];
  initiative: Initiative;
}

export function WorkstreamCard({ workstream, tasks, initiative }: WorkstreamCardProps) {
  const { openModal, agentEntityMap } = useMissionControl();
  const agents = agentEntityMap.get(workstream.id) ?? agentEntityMap.get(initiative.id) ?? [];

  const activeTasks = tasks.filter((t) =>
    ['active', 'in_progress'].includes(t.status.toLowerCase())
  ).length;
  const doneTasks = tasks.filter((t) =>
    ['done', 'completed'].includes(t.status.toLowerCase())
  ).length;

  return (
    <motion.button
      onClick={() => openModal({ type: 'workstream', entity: workstream, initiative })}
      className="w-[260px] flex-shrink-0 text-left glass-panel soft-shadow rounded-xl p-3.5 transition-all hover-lift"
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="truncate text-[13px] font-medium text-white/90">
          {workstream.name}
        </h4>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getWorkstreamStatusClass(workstream.status)}`}
        >
          {formatEntityStatus(workstream.status)}
        </span>
      </div>

      {workstream.progress !== null && (
        <div className="mb-2">
          <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.round(workstream.progress)}%`, backgroundColor: colors.lime }}
            />
          </div>
          <span className="mt-0.5 block text-[10px] text-white/30">
            {Math.round(workstream.progress)}%
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[10px] text-white/35 uppercase tracking-[0.08em]">
          <span>{tasks.length} tasks</span>
          {activeTasks > 0 && (
            <span style={{ color: `${colors.lime}99` }}>{activeTasks} active</span>
          )}
          {doneTasks > 0 && (
            <span style={{ color: `${colors.teal}99` }}>{doneTasks} done</span>
          )}
        </div>
        <InferredAgentAvatars agents={agents} max={3} />
      </div>
    </motion.button>
  );
}
