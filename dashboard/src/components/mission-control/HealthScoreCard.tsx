import { colors } from '@/lib/tokens';
import { ProgressRing } from '@/components/shared/ProgressRing';

interface HealthScoreCardProps {
  completionPercent: number;
  totalTasks: number;
  doneTasks: number;
  blockedCount: number;
  activeAgents: number;
  className?: string;
}

export function HealthScoreCard({
  completionPercent,
  totalTasks,
  doneTasks,
  blockedCount,
  activeAgents,
  className,
}: HealthScoreCardProps) {
  // Composite health: completion weighted + inverse blockers + agent activity
  const completionScore = completionPercent * 0.6;
  const blockerPenalty = Math.min(blockedCount * 10, 30);
  const agentBonus = Math.min(activeAgents * 5, 10);
  const healthScore = Math.max(0, Math.min(100, completionScore + agentBonus - blockerPenalty + 40));
  const score = Math.round(healthScore / 10);
  const isHealthy = score >= 7;

  return (
    <div className={`${isHealthy ? 'surface-hero' : 'surface-tier-2'} rounded-2xl px-5 py-4 ${className ?? ''}`}>
      <div className="flex items-center gap-5">
        <ProgressRing percent={healthScore} size={56} />
        <div className="min-w-0 flex-1">
          <p
            className="text-display font-light"
            style={{
              color: score >= 7 ? colors.lime : score >= 5 ? colors.amber : colors.red,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {score}<span className="text-sm font-normal text-muted">/10</span>
          </p>
          <p className="text-caption text-secondary mt-0.5">Health Score</p>
        </div>
        <div className="flex items-center gap-6 flex-shrink-0">
          <div className="text-center">
            <p className="text-body font-light tabular-nums" style={{ color: colors.teal }}>
              {doneTasks}/{totalTasks}
            </p>
            <p className="text-micro text-muted">tasks</p>
          </div>
          <div className="text-center">
            <p className="text-body font-light tabular-nums" style={{ color: blockedCount > 0 ? colors.red : 'rgba(255,255,255,0.2)' }}>
              {blockedCount}
            </p>
            <p className="text-micro text-muted">blocked</p>
          </div>
          <div className="text-center">
            <p className="text-body font-light tabular-nums" style={{ color: activeAgents > 0 ? colors.lime : 'rgba(255,255,255,0.2)' }}>
              {activeAgents}
            </p>
            <p className="text-micro text-muted">agents</p>
          </div>
        </div>
      </div>
    </div>
  );
}
