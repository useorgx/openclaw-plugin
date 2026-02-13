import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/time';
import { humanizeModel, humanizeText } from '@/lib/humanize';
import type { LiveActivityItem, SessionTreeNode } from '@/types';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ActivityEventIcon, resolveActivityVisual } from './activityVisuals';

interface ThreadViewProps {
  /** Activity items filtered to a single session. */
  items: LiveActivityItem[];
  /** The session this thread belongs to. */
  session: SessionTreeNode | null;
  /** Agent name for display. */
  agentName: string | null;
  /** Called to exit thread view. */
  onBack: () => void;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatCost(items: LiveActivityItem[]): string | null {
  let total = 0;
  for (const item of items) {
    const cost = (item.metadata as Record<string, unknown> | undefined)?.costTotal;
    if (typeof cost === 'number') total += cost;
  }
  if (total <= 0) return null;
  if (total < 0.01) return '<$0.01';
  return `$${total.toFixed(2)}`;
}

export const ThreadView = memo(function ThreadView({
  items,
  session,
  agentName,
  onBack,
}: ThreadViewProps) {
  const [showProvenance, setShowProvenance] = useState(false);

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      ),
    [items]
  );

  const cost = useMemo(() => formatCost(sorted), [sorted]);

  const duration = useMemo(() => {
    if (sorted.length < 2) return null;
    const first = Date.parse(sorted[0].timestamp);
    const last = Date.parse(sorted[sorted.length - 1].timestamp);
    const diffMs = last - first;
    if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
    if (diffMs < 3600_000) return `${Math.round(diffMs / 60_000)}m`;
    return `${(diffMs / 3600_000).toFixed(1)}h`;
  }, [sorted]);

  const provenance = useMemo(() => {
    let domain: string | null = null;
    let provider: string | null = null;
    let model: string | null = null;
    let modelTier: string | null = null;
    let kickoffContextHash: string | null = null;

    for (const item of sorted) {
      const md = item.metadata as Record<string, unknown> | undefined;
      if (!md) continue;
      if (!domain && typeof md.domain === 'string') domain = md.domain;
      if (!provider && typeof md.provider === 'string') provider = md.provider;
      if (!model && typeof md.model === 'string') model = md.model;
      if (!modelTier && typeof md.spawn_guard_model_tier === 'string') modelTier = md.spawn_guard_model_tier;
      if (!kickoffContextHash && typeof md.kickoff_context_hash === 'string') kickoffContextHash = md.kickoff_context_hash;
      if (domain && (provider || model) && modelTier && kickoffContextHash) break;
    }

    const hasAny = Boolean(domain || provider || model || modelTier || kickoffContextHash);
    if (!hasAny) return null;

    return { domain, provider, model, modelTier, kickoffContextHash };
  }, [sorted]);

  const sessionTitle = session?.title ?? agentName ?? 'Session';

  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="border-b border-subtle px-4 py-3">
        <button
          onClick={onBack}
          className="mb-2 flex items-center gap-1.5 text-caption text-secondary transition-colors hover:text-primary"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to timeline
        </button>

        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: colors.lime,
              boxShadow: `0 0 12px ${colors.lime}55`,
            }}
          />
          <h3 className="text-heading font-semibold text-white">
            {humanizeText(sessionTitle)}
          </h3>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-micro text-secondary">
          {agentName && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-subtle px-1 py-0.5">
              <AgentAvatar name={agentName} hint={session?.id ?? session?.runId ?? null} size="xs" />
              <span>{agentName}</span>
            </span>
          )}
          <span>{sorted.length} turn{sorted.length !== 1 ? 's' : ''}</span>
          {duration && <span>{duration}</span>}
          {cost && (
            <span className="text-muted">{cost}</span>
          )}
          {provenance?.domain && (
            <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary">
              {humanizeText(provenance.domain)}
            </span>
          )}
          {session?.status && (
            <span
              className="rounded-full px-1.5 py-0.5 text-micro uppercase tracking-wider"
              style={{
                backgroundColor:
                  session.status === 'running'
                    ? `${colors.lime}20`
                    : session.status === 'failed'
                      ? `${colors.red}20`
                      : `${colors.teal}20`,
                color:
                  session.status === 'running'
                    ? colors.lime
                    : session.status === 'failed'
                      ? colors.red
                      : colors.teal,
              }}
            >
              {session.status}
            </span>
          )}
          {provenance && (provenance.provider || provenance.model || provenance.modelTier || provenance.kickoffContextHash) && (
            <button
              type="button"
              onClick={() => setShowProvenance((p) => !p)}
              className="inline-flex items-center gap-1 text-micro text-muted transition-colors hover:text-secondary"
            >
              <svg
                width="8"
                height="8"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`transition-transform duration-150 ${showProvenance ? 'rotate-180' : ''}`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              Info
            </button>
          )}
        </div>

        {showProvenance && provenance && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro">
            {(provenance.provider || provenance.model) && (
              <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary">
                {provenance.provider ? `${humanizeText(provenance.provider)} · ` : ''}
                {provenance.model ? humanizeModel(provenance.model) : '—'}
              </span>
            )}
            {provenance.modelTier && (
              <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary">
                tier: {humanizeText(provenance.modelTier)}
              </span>
            )}
            {provenance.kickoffContextHash && (
              <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 font-mono text-secondary">
                kickoff {provenance.kickoffContextHash.slice(0, 8)}…
              </span>
            )}
          </div>
        )}
      </div>

      {/* Turn list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <AnimatePresence mode="popLayout">
          <div className="relative">
            {/* Vertical connector line */}
            <div
              className="absolute left-[7px] top-3 bottom-3 w-px"
              style={{ backgroundColor: `${colors.iris}25` }}
            />

            <div className="space-y-1">
              {sorted.map((item, index) => {
                const visual = resolveActivityVisual(item);
                const color = visual.color;
                const modelField = (item.metadata as Record<string, unknown> | undefined)?.model;
                const model = typeof modelField === 'string' ? humanizeModel(modelField) : null;
                const title = humanizeText(item.title ?? '');
                const isError = item.type === 'run_failed';
                const isArtifact = item.type === 'artifact_created';
                const isDecision =
                  item.type === 'decision_requested' ||
                  item.type === 'decision_resolved';

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.02 }}
                    className="group relative flex items-start gap-2.5 rounded-lg py-1.5 pl-0 pr-2 transition-colors hover:bg-white/[0.02]"
                  >
                    {/* Dot on the timeline */}
                    <span
                      className="relative z-10 mt-1.5 flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-full text-[8px]"
                      style={{
                        backgroundColor: `${color}20`,
                        color,
                        border: `1px solid ${color}40`,
                      }}
                    >
                      <ActivityEventIcon icon={visual.icon} size={8} className="opacity-95" />
                    </span>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-body leading-snug ${
                          isError
                            ? 'text-red-400'
                            : isDecision
                              ? 'text-amber-300'
                              : isArtifact
                                ? 'text-cyan-300'
                                : 'text-bright'
                        }`}
                      >
                        {title}
                      </p>

                      {item.summary && item.summary !== title && (
                        <p className="mt-0.5 text-caption leading-relaxed text-muted">
                          {humanizeText(item.summary)}
                        </p>
                      )}
                    </div>

                    {/* Right side: time + model */}
                    <div className="flex flex-shrink-0 flex-col items-end gap-0.5 pt-0.5">
                      <span className="text-micro text-muted" title={formatAbsoluteTime(item.timestamp)}>
                        {formatTime(item.timestamp)}
                      </span>
                      {model && (
                        <span className="text-micro text-faint">
                          {model}
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </AnimatePresence>

        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-body text-secondary">No activity in this session yet.</p>
            <p className="text-caption text-muted animate-pulse">Activity may take a moment to appear.</p>
          </div>
        )}

        {/* Session summary footer */}
        {sorted.length > 0 && (
          <div className="mt-4 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2 text-micro text-muted">
            {sorted.length} turn{sorted.length !== 1 ? 's' : ''}
            {duration ? ` over ${duration}` : ''}
            {cost ? ` \u00B7 ${cost}` : ''}
            {' \u00B7 '}
            <span title={formatAbsoluteTime(sorted[sorted.length - 1].timestamp)}>{formatRelativeTime(sorted[sorted.length - 1].timestamp)}</span>
          </div>
        )}
      </div>
    </div>
  );
});
