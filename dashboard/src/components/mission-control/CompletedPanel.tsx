import { memo } from 'react';
import { motion } from 'framer-motion';
import type { LiveActivityItem, SliceRunArtifactSummary } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { Pill } from '@/components/shared/Pill';
import { formatRelativeTime } from '@/lib/time';
import { sanitizeDisplayText } from '@/lib/humanize';

export type CompletedWorkRow = {
  key: string;
  runId: string;
  title: string;
  statusExplainer: string | null;
  initiativeTitle: string | null;
  workstreamTitle: string | null;
  scope: 'task' | 'milestone' | 'workstream' | null;
  taskIds: string[];
  milestoneIds: string[];
  artifacts: SliceRunArtifactSummary[];
  artifactCount: number;
  completedAt: string | null;
  timelineEvents: LiveActivityItem[];
};

interface CompletedPanelProps {
  className?: string;
  rows: CompletedWorkRow[];
  onFocusRunId?: (runId: string) => void;
  onOpenNextUp?: () => void;
}

function formatAbsolute(value: string | null): string {
  if (!value) return 'Unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  return new Date(parsed).toLocaleString();
}

function formatRelative(value: string | null): string {
  if (!value) return 'unknown';
  return formatRelativeTime(value);
}

const statusTone: Record<string, string> = {
  run_completed: 'text-[#BFFF00]',
  milestone_completed: 'text-[#7dd3c0]',
  artifact_created: 'text-cyan-200',
  handoff_fulfilled: 'text-violet-200',
  decision_resolved: 'text-amber-200',
  run_started: 'text-white/80',
  delegation: 'text-white/80',
};

function eventLabel(event: LiveActivityItem): string {
  const direct = event.title?.trim();
  if (direct) return direct;
  return event.type.replace(/_/g, ' ');
}

export const CompletedPanel = memo(function CompletedPanel({
  className,
  rows,
  onFocusRunId,
  onOpenNextUp,
}: CompletedPanelProps) {
  if (rows.length === 0) {
    return (
      <PremiumCard className={className ?? ''}>
        <div className="flex h-full min-h-[220px] items-center justify-center px-5 py-8 text-center">
          <div>
            <p className="text-body font-medium text-primary">No completed work in this scope yet.</p>
            <p className="mt-1 text-caption text-secondary">
              Completed slices will appear here with full scope, artifacts, and timeline.
            </p>
          </div>
        </div>
      </PremiumCard>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2 ${className ?? ''}`}>
      {rows.map((row, index) => (
        <motion.section
          key={row.key}
          initial={{ opacity: 0, y: 10, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{
            duration: 0.26,
            delay: Math.min(index, 6) * 0.035,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="rounded-xl border border-subtle bg-white/[0.02] p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-primary">{sanitizeDisplayText(row.title)}</p>
              <p className="mt-0.5 text-caption text-secondary">
                Completed {formatRelative(row.completedAt)} · {formatAbsolute(row.completedAt)}
              </p>
              {row.statusExplainer ? (
                <p className="mt-0.5 truncate text-micro text-muted">
                  {sanitizeDisplayText(row.statusExplainer)}
                </p>
              ) : null}
            </div>
            <Pill tone="lime" className="whitespace-nowrap">
              Completed
            </Pill>
          </div>

          <div className="mt-2 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2">
            <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">Hierarchy</p>
            <p className="mt-1 text-caption text-primary">
              {sanitizeDisplayText(
                [row.initiativeTitle, row.workstreamTitle].filter(Boolean).join(' > ') || 'Unscoped'
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
              {row.scope && <span className="chip capitalize">{row.scope}</span>}
              <span className="chip">{row.taskIds.length} tasks</span>
              <span className="chip">{row.milestoneIds.length} milestones</span>
            </div>
          </div>

          <div className="mt-2 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2">
            <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">
              Artifacts ({row.artifactCount})
            </p>
            {row.artifacts.length > 0 ? (
              <ul className="mt-1.5 space-y-1.5">
                {row.artifacts.map((artifact) => (
                  <li
                    key={`${row.key}:${artifact.id ?? artifact.title}`}
                    className="flex items-center justify-between gap-2 text-caption"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-primary">{sanitizeDisplayText(artifact.title)}</p>
                      <p className="text-micro text-secondary">
                        {artifact.type ?? 'artifact'} · {formatRelative(artifact.createdAt)}
                      </p>
                    </div>
                    {artifact.url ? (
                      <a
                        href={artifact.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-primary transition hover:bg-white/[0.08]"
                      >
                        Open
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-caption text-secondary">No artifact metadata attached.</p>
            )}
          </div>

          <div className="mt-2 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2">
            <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">
              Timeline ({row.timelineEvents.length})
            </p>
            {row.timelineEvents.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {row.timelineEvents.map((event, evtIndex) => {
                  const tone = statusTone[event.type] ?? 'text-primary';
                  return (
                    <motion.li
                      key={`${row.key}:event:${event.id}`}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: Math.min(evtIndex, 8) * 0.025, ease: [0.22, 1, 0.36, 1] }}
                      className="flex items-start justify-between gap-2 text-caption"
                    >
                      <div className="min-w-0">
                        <p className={`truncate ${tone}`}>{sanitizeDisplayText(eventLabel(event))}</p>
                        {event.description ? (
                          <p className="truncate text-micro text-secondary">
                            {sanitizeDisplayText(event.description)}
                          </p>
                        ) : null}
                      </div>
                      <span className="whitespace-nowrap text-micro text-muted">
                        {formatRelativeTime(event.timestamp)}
                      </span>
                    </motion.li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1.5 text-caption text-secondary">No related timeline events found.</p>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {onFocusRunId ? (
              <button
                type="button"
                onClick={() => onFocusRunId(row.runId)}
                className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption font-semibold text-primary transition hover:bg-white/[0.1]"
              >
                Open work session
              </button>
            ) : null}
            {onOpenNextUp ? (
              <button
                type="button"
                onClick={onOpenNextUp}
                className="rounded-full border border-[#BFFF00]/28 bg-[#BFFF00]/12 px-3 py-1 text-caption font-semibold text-[#E3FFAE] transition hover:bg-[#BFFF00]/18"
              >
                Connect back to Next Up
              </button>
            ) : null}
          </div>
        </motion.section>
      ))}
    </div>
  );
});
