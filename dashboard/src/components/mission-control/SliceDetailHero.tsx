import { motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { MetricRow } from '@/components/shared/MetricRow';
import type { SliceRunProjection } from '@/types';

interface SliceDetailHeroProps {
  workstreamTitle: string;
  initiativeTitle?: string | null;
  agentName?: string | null;
  agentHint?: string | null;
  status: string;
  statusLabel: string;
  statusClass: string;
  isRunning?: boolean;
  sliceRun?: SliceRunProjection | null;
  onOpenInitiative?: () => void;
}

const heroVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] as number[] },
  }),
};

export function SliceDetailHero({
  workstreamTitle,
  initiativeTitle,
  agentName,
  agentHint,
  statusLabel,
  statusClass,
  isRunning,
  sliceRun,
  onOpenInitiative,
}: SliceDetailHeroProps) {
  const duration = computeDuration(sliceRun);
  const artifactCount = sliceRun?.artifactCount ?? 0;
  const decisionCount = sliceRun?.decisionCount ?? 0;
  const confidence = sliceRun?.confidence ?? null;

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      {initiativeTitle && (
        <motion.div
          className="flex items-center gap-2 text-[13px] text-secondary"
          variants={heroVariants}
          initial="hidden"
          animate="visible"
          custom={0}
        >
          {onOpenInitiative ? (
            <button
              type="button"
              onClick={onOpenInitiative}
              className="truncate hover:text-white transition-colors"
            >
              {initiativeTitle}
            </button>
          ) : (
            <span className="truncate">{initiativeTitle}</span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0 opacity-40">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="truncate text-white font-medium">{workstreamTitle}</span>
        </motion.div>
      )}

      {/* Hero */}
      <motion.div
        className="flex items-start gap-3"
        variants={heroVariants}
        initial="hidden"
        animate="visible"
        custom={1}
      >
        <AgentAvatar name={agentName ?? 'OrgX'} hint={agentHint ?? agentName} size="md" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[28px] font-medium leading-none text-white truncate">
            {workstreamTitle}
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center rounded-full border px-2 py-[1px] text-micro font-semibold uppercase tracking-widest ${statusClass}`}>
              {isRunning && (
                <span className="relative mr-1.5 inline-block h-1.5 w-1.5">
                  <span className="absolute inset-0 rounded-full bg-current live-pulse" />
                  <span className="absolute inset-0 rounded-full bg-current" />
                </span>
              )}
              {statusLabel}
            </span>
            {confidence && (
              <span className={`chip text-[9px] font-semibold ${
                confidence === 'high' ? 'border-[#BFFF00]/30 bg-[#BFFF00]/[0.12] text-[#d8ffa1]'
                : confidence === 'medium' ? 'border-[#F5B700]/30 bg-[#F5B700]/[0.12] text-[#FFE7A8]'
                : 'border-white/[0.12] bg-white/[0.05] text-white/60'
              }`}>
                {confidence} confidence
              </span>
            )}
          </div>
          {sliceRun?.statusExplainer && (
            <p className="mt-2 text-body text-secondary">{sliceRun.statusExplainer}</p>
          )}
        </div>
      </motion.div>

      {/* Metrics */}
      <motion.div
        variants={heroVariants}
        initial="hidden"
        animate="visible"
        custom={2}
      >
        <MetricRow
          metrics={[
            ...(duration ? [{ label: 'Duration', value: duration }] : []),
            { label: 'Artifacts', value: artifactCount, color: colors.teal },
            { label: 'Decisions', value: decisionCount, color: colors.amber },
          ]}
          className="pt-2 pb-4 border-b border-white/[0.04]"
        />
      </motion.div>
    </div>
  );
}

function computeDuration(sliceRun: SliceRunProjection | null | undefined): string | null {
  if (!sliceRun?.startedAt) return null;
  const end = sliceRun.completedAt ?? sliceRun.failedAt ?? sliceRun.updatedAt ?? new Date().toISOString();
  const ms = Date.parse(end) - Date.parse(sliceRun.startedAt);
  if (ms < 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
