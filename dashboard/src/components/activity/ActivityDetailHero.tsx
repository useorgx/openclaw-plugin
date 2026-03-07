import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { motion as motionTokens } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeActivitySummary } from '@/lib/humanize';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { LiveActivityItem, SliceRunArtifactSummary } from '@/types';
import { ArtifactGallery } from '@/components/mission-control/ArtifactGallery';

interface ActivityDetailHeroProps {
  item: LiveActivityItem;
  className?: string;
}

function resolveTone(item: LiveActivityItem): 'teal' | 'amber' | 'red' | 'neutral' {
  const phase = ((item as unknown as Record<string, unknown>).phase as string) ?? '';
  const state = ((item as unknown as Record<string, unknown>).state as string) ?? '';
  const evType = item.type ?? '';
  const combined = `${phase} ${state} ${evType}`.toLowerCase();
  if (/complet|success|auto_continue_started/.test(combined)) return 'teal';
  if (/budget|exhaust|stop|paused/.test(combined)) return 'amber';
  if (/block|error|fail/.test(combined)) return 'red';
  return 'neutral';
}

const TONE_STYLES = {
  teal: { dot: 'bg-[#0AD4C4]', label: 'text-[#7AEDE5]' },
  amber: { dot: 'bg-[#F5B700]', label: 'text-[#FFE7A8]' },
  red: { dot: 'bg-[#FF6B6B]', label: 'text-[#FFA8A8]' },
  neutral: { dot: 'bg-white/40', label: 'text-secondary' },
};

export function ActivityDetailHero({ item, className }: ActivityDetailHeroProps) {
  const [showDetails, setShowDetails] = useState(false);
  const summary = humanizeActivitySummary(item);
  const tone = resolveTone(item);
  const styles = TONE_STYLES[tone];
  const agentName = item.agentName ?? 'OrgX';
  const timestamp = item.timestamp ? formatRelativeTime(item.timestamp) : null;

  const artifacts: SliceRunArtifactSummary[] = (() => {
    const meta = (item as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    const raw = meta?.artifacts;
    if (!Array.isArray(raw)) return [];
    return raw.map((a: Record<string, unknown>) => ({
      id: String(a.id ?? ''),
      type: a.type != null ? String(a.type) : null,
      title: String(a.title ?? a.name ?? 'Untitled'),
      url: a.url != null ? String(a.url) : null,
      createdAt: a.createdAt != null ? String(a.createdAt) : null,
    }));
  })();

  return (
    <div className={className}>
      {/* Hero */}
      <div className="flex items-start gap-3">
        <AgentAvatar name={agentName} hint={agentName} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-title font-medium text-white truncate">
              {summary.taskDescription ?? item.title ?? 'Activity'}
            </h4>
            <span className={`inline-flex items-center gap-1.5 chip text-[9px] ${styles.label}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
              {agentName}
            </span>
          </div>
          {timestamp && (
            <p className="mt-0.5 text-micro text-muted tabular-nums">{timestamp}</p>
          )}
          {summary.outcomeDescription && (
            <p className="mt-2 text-body text-secondary leading-relaxed">
              {summary.outcomeDescription}
            </p>
          )}
          {summary.nextStep && (
            <p className="mt-1 text-caption text-muted">
              Next: {summary.nextStep}
            </p>
          )}
        </div>
      </div>

      {/* Artifacts */}
      {artifacts.length > 0 && (
        <ArtifactGallery artifacts={artifacts} className="mt-4" />
      )}

      {/* Collapsible details */}
      {(item.description || item.summary) && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="control-pill h-7 px-3 text-micro font-semibold"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          <AnimatePresence>
            {showDetails && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: motionTokens.durationEntrance / 1000 }}
                className="overflow-hidden"
              >
                <div className="mt-3 rounded-xl subsection-shell px-4 py-3 text-body text-secondary leading-relaxed">
                  {item.summary ?? item.description}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
