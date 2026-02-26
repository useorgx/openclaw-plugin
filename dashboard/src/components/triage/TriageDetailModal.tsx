import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LiveTriageItem, LiveDecision, TriageAction } from '@/types';
import type { TriageQueueActions } from '@/hooks/useTriageQueue';
import { formatRelativeTime } from '@/lib/time';
import { colors } from '@/lib/tokens';
import { EvidenceCard } from '@/components/shared/EvidenceCard';
import { SectionHeading } from '@/components/shared/SectionHeading';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { ScopeProgressCard, buildScopeFromContext } from '@/components/shared/ScopeProgressCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindLabel(kind: string): string {
  switch (kind) {
    case 'decision_required':
      return 'Decision required';
    case 'blocked_intervention':
      return 'Blocked — needs intervention';
    case 'review_required':
      return 'Review required';
    case 'failure_diagnostic':
      return 'Failure diagnostic';
    default:
      return kind;
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '#FF6B6B';
    case 'high':
      return '#F5B700';
    case 'medium':
      return '#0AD4C4';
    default:
      return '#8B8FA3';
  }
}

// ---------------------------------------------------------------------------
// Section Components
// ---------------------------------------------------------------------------

function ProofSection({
  item,
  onOpenTerminal,
}: {
  item: LiveTriageItem;
  onOpenTerminal?: (logRef: string) => void;
}) {
  const bundle = item.proofBundle;
  const hasProof =
    bundle.artifactRefs.length > 0 ||
    bundle.fileChanges.length > 0 ||
    bundle.prRefs.length > 0 ||
    bundle.logRefs.length > 0 ||
    bundle.decisionRefs.length > 0;

  if (!hasProof) return null;

  return (
    <div>
      <SectionHeading>Evidence</SectionHeading>
      <div className="space-y-1.5">
        {bundle.prRefs.map((ref, i) => (
          <EvidenceCard key={`pr-${i}`} icon="pr" label={ref} />
        ))}
        {bundle.fileChanges.map((ref, i) => (
          <EvidenceCard key={`file-${i}`} icon="file" label={ref} />
        ))}
        {bundle.artifactRefs.map((ref, i) => (
          <EvidenceCard key={`art-${i}`} icon="artifact" label={ref} />
        ))}
        {bundle.logRefs.map((ref, i) => (
          <EvidenceCard
            key={`log-${i}`}
            icon="log"
            label={ref}
            onOpenTerminal={onOpenTerminal ? () => onOpenTerminal(ref) : undefined}
          />
        ))}
        {bundle.decisionRefs.map((ref, i) => (
          <EvidenceCard key={`dec-${i}`} icon="decision" label={ref} />
        ))}
      </div>
    </div>
  );
}

function ImpactBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-caption text-secondary">{label}</span>
        <span className="text-caption font-medium" style={{ color }}>{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}

function ImpactSection({ item }: { item: LiveTriageItem }) {
  const { impact } = item;
  if (
    impact.initiativeCount === 0 &&
    impact.workstreamCount === 0 &&
    impact.downstreamBlockedCount === 0
  ) {
    return null;
  }

  const max = Math.max(
    impact.initiativeCount,
    impact.workstreamCount,
    impact.downstreamBlockedCount,
    1
  );

  return (
    <div>
      <SectionHeading>Impact if ignored</SectionHeading>
      <div className="space-y-2.5">
        {impact.initiativeCount > 0 && (
          <ImpactBar
            label={`${impact.initiativeCount} initiative${impact.initiativeCount > 1 ? 's' : ''}`}
            value={impact.initiativeCount}
            max={max}
            color={colors.amber}
          />
        )}
        {impact.workstreamCount > 0 && (
          <ImpactBar
            label={`${impact.workstreamCount} workstream${impact.workstreamCount > 1 ? 's' : ''}`}
            value={impact.workstreamCount}
            max={max}
            color={colors.amber}
          />
        )}
        {impact.downstreamBlockedCount > 0 && (
          <ImpactBar
            label={`${impact.downstreamBlockedCount} blocked downstream`}
            value={impact.downstreamBlockedCount}
            max={max}
            color={colors.red}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action Button
// ---------------------------------------------------------------------------

function ActionButton({
  triageAction,
  onPerform,
  isActing,
}: {
  triageAction: TriageAction;
  onPerform: (action: string, note?: string) => void;
  isActing: boolean;
}) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');
  const [isHovering, setIsHovering] = useState(false);

  const isPrimary =
    triageAction.action === 'approve' || triageAction.action === 'autofix';
  const isDanger = triageAction.action === 'dismiss';

  const baseClass = isPrimary
    ? 'bg-[#0AD4C4]/20 text-[#7AEDE5] hover:bg-[#0AD4C4]/30'
    : isDanger
      ? 'bg-[#FF6B6B]/14 text-[#FFA8A8] hover:bg-[#FF6B6B]/20'
      : 'bg-white/[0.08] text-secondary hover:bg-white/[0.12]';

  if (!triageAction.available) {
    return (
      <button
        type="button"
        disabled
        className="rounded-lg px-3 py-1.5 text-caption font-medium opacity-30 bg-white/[0.06] text-muted cursor-not-allowed"
        title="Not available"
      >
        {triageAction.label}
      </button>
    );
  }

  if (triageAction.requiresNote && showNote) {
    return (
      <div className="flex flex-col gap-1.5 w-full">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note..."
          className="w-full rounded-lg border border-subtle bg-white/[0.04] px-2.5 py-1.5 text-caption text-primary placeholder:text-muted resize-none"
          rows={2}
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => onPerform(triageAction.action, note)}
            disabled={isActing}
            className={`rounded-lg px-3 py-1 text-caption font-medium transition-colors disabled:opacity-40 ${baseClass}`}
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setShowNote(false)}
            className="text-caption text-muted hover:text-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onFocus={() => setIsHovering(true)}
        onBlur={() => setIsHovering(false)}
        onClick={() => {
          if (triageAction.requiresNote) {
            setShowNote(true);
          } else {
            onPerform(triageAction.action);
          }
        }}
        disabled={isActing}
        className={`w-full rounded-lg px-3 py-1.5 text-left text-caption font-medium transition-colors disabled:opacity-40 ${baseClass}`}
      >
        <span>{triageAction.label}</span>
      </button>
      {isHovering && triageAction.consequences ? (
        <p className="px-1 text-micro text-secondary">{triageAction.consequences}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Technical Details (collapsed by default)
// ---------------------------------------------------------------------------

function TechnicalDetails({ item }: { item: LiveTriageItem }) {
  const [open, setOpen] = useState(false);

  const details = [
    ['ID', item.id],
    ['Kind', item.kind],
    ['Dedupe key', item.dedupeKey],
    ['Source system', item.sourceSystem],
    ['Conflict source', item.conflictSource],
    ['Agent ID', item.agentId],
    ['Source decision', item.sourceDecisionId],
    ['Source activity', item.sourceActivityId],
    ['First seen', item.firstSeenAt],
    ['Last seen', item.lastSeenAt],
    ['Created', item.createdAt],
  ].filter(([, v]) => v != null) as [string, string][];

  return (
    <div className="border-t border-subtle pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-micro font-semibold uppercase tracking-wider text-muted hover:text-secondary transition-colors"
      >
        <span>Technical details</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 space-y-0.5">
          {details.map(([k, v]) => (
            <div key={k} className="flex gap-2 text-micro">
              <span className="text-muted w-28 flex-shrink-0">{k}</span>
              <span className="text-secondary truncate">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle Timeline
// ---------------------------------------------------------------------------

function LifecycleTimeline({ item }: { item: LiveTriageItem }) {
  const events: Array<{ label: string; time: string }> = [];

  if (item.firstSeenAt) events.push({ label: 'First seen', time: item.firstSeenAt });
  if (item.createdAt && item.createdAt !== item.firstSeenAt)
    events.push({ label: 'Created', time: item.createdAt });
  if (item.snoozedUntil) events.push({ label: 'Snoozed until', time: item.snoozedUntil });
  if (item.lastSeenAt && item.lastSeenAt !== item.firstSeenAt)
    events.push({ label: 'Last seen', time: item.lastSeenAt });
  if (item.updatedAt && item.updatedAt !== item.createdAt)
    events.push({ label: 'Updated', time: item.updatedAt });

  // Only render when > 1 distinct timestamp
  if (events.length <= 1) return null;

  return (
    <div>
      <SectionHeading>Timeline</SectionHeading>
      <div className="relative pl-4">
        {/* Vertical line */}
        <div className="absolute left-[5px] top-1 bottom-1 w-px bg-white/[0.08]" />
        <div className="space-y-2">
          {events.map((evt, i) => (
            <div key={i} className="relative flex items-center gap-2.5">
              {/* Dot */}
              <div className="absolute left-[-13px] h-2.5 w-2.5 rounded-full border border-white/[0.15] bg-white/[0.06]" />
              <span className="text-micro text-muted w-20 flex-shrink-0">{evt.label}</span>
              <span className="text-micro text-secondary">{formatRelativeTime(evt.time)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Embedded Decision Flow
// ---------------------------------------------------------------------------

function EmbeddedDecisionFlow({
  decision,
  onApprove,
  onReject,
}: {
  decision: LiveDecision;
  onApprove?: (id: string, input?: { note?: string; optionId?: string }) => Promise<{ updated: number; failed: number }>;
  onReject?: (id: string, input?: { note?: string; optionId?: string }) => Promise<{ updated: number; failed: number }>;
}) {
  const [selectedOption, setSelectedOption] = useState<string | null>(
    decision.selectedOptionId ??
    (decision.options && decision.options.length === 1 ? decision.options[0].id : null)
  );
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [result, setResult] = useState<'approved' | 'rejected' | null>(null);

  const options = decision.options ?? [];
  const selectedOptionRecord = options.find((o) => o.id === selectedOption) ?? null;

  const handleAction = async (action: 'approve' | 'reject') => {
    const handler = action === 'approve' ? onApprove : onReject;
    if (!handler) return;
    setActing(action);
    try {
      const input: { note?: string; optionId?: string } = {};
      if (note.trim()) input.note = note.trim();
      if (selectedOptionRecord?.id) input.optionId = selectedOptionRecord.id;
      const res = await handler(decision.id, Object.keys(input).length > 0 ? input : undefined);
      if (res.failed === 0) {
        setResult(action === 'approve' ? 'approved' : 'rejected');
      }
    } catch {
      // Handled by parent
    } finally {
      setActing(null);
    }
  };

  if (result) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-center">
        <p className="text-caption text-secondary">
          Decision {result}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-300/[0.2] bg-cyan-500/[0.06] px-4 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <EntityIcon type="decision" size={12} />
        <p className="text-caption font-medium text-primary">{decision.title}</p>
      </div>

      {/* Recommended action */}
      {decision.recommendedAction && (
        <p className="text-micro text-cyan-200">
          Recommended: {decision.recommendedAction}
        </p>
      )}

      {/* Options as selectable cards */}
      {options.length > 0 && (
        <div className="space-y-1">
          {options.map((option) => {
            const isActive = selectedOption === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedOption(isActive ? null : option.id)}
                disabled={acting !== null}
                className="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all"
                style={{
                  borderColor: isActive ? `${colors.lime}50` : 'rgba(255,255,255,0.06)',
                  backgroundColor: isActive ? `${colors.lime}08` : 'rgba(255,255,255,0.02)',
                }}
              >
                <div
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors"
                  style={{ borderColor: isActive ? colors.lime : 'rgba(255,255,255,0.2)' }}
                >
                  {isActive && (
                    <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors.lime }} />
                  )}
                </div>
                <span className={`text-caption ${isActive ? 'font-medium text-white' : 'text-secondary'}`}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Note */}
      {showNote && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note..."
          className="w-full rounded-lg border border-subtle bg-white/[0.04] px-2.5 py-1.5 text-caption text-primary placeholder:text-muted resize-none"
          rows={2}
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {onApprove && (
          <button
            type="button"
            onClick={() => handleAction('approve')}
            disabled={acting !== null || (options.length > 0 && !selectedOptionRecord)}
            className="rounded-lg px-3 py-1.5 text-caption font-semibold transition-all disabled:opacity-40"
            style={{ backgroundColor: colors.lime, color: '#000' }}
          >
            {acting === 'approve' ? 'Approving...' : 'Approve'}
          </button>
        )}
        {onReject && (
          <button
            type="button"
            onClick={() => handleAction('reject')}
            disabled={acting !== null}
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-caption font-medium text-secondary transition-colors hover:border-red-400/30 hover:text-red-300 disabled:opacity-40"
          >
            {acting === 'reject' ? 'Rejecting...' : 'Reject'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowNote((p) => !p)}
          className="text-caption text-muted hover:text-secondary transition-colors"
        >
          {showNote ? 'Hide note' : 'Note'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal Helper
// ---------------------------------------------------------------------------

function inferTerminalTarget(item: LiveTriageItem): { runId?: string; logPath?: string } | null {
  const logRef = item.proofBundle.logRefs.find(
    (ref) => typeof ref === 'string' && ref.trim().length > 0
  );
  if (!logRef) return null;
  const trimmed = logRef.trim();
  const leaf = trimmed.split(/[\\/]/).pop() ?? '';
  const inferredRunId = leaf.replace(/\.(log|output\.json)$/i, '').trim();
  const target: { runId?: string; logPath?: string } = {};
  if (trimmed.length > 0) target.logPath = trimmed;
  if (inferredRunId.length > 0) target.runId = inferredRunId;
  return Object.keys(target).length > 0 ? target : null;
}

// ---------------------------------------------------------------------------
// Main Modal
// ---------------------------------------------------------------------------

export interface TriageDetailModalProps {
  item: LiveTriageItem | null;
  actions: TriageQueueActions;
  onClose: () => void;
  onNavigate?: (direction: 1 | -1) => void;
  currentIndex?: number;
  totalCount?: number;
  // New props
  decisions?: LiveDecision[];
  onApproveDecision?: (id: string, input?: { note?: string; optionId?: string }) => Promise<{ updated: number; failed: number }>;
  onRejectDecision?: (id: string, input?: { note?: string; optionId?: string }) => Promise<{ updated: number; failed: number }>;
  onFocusRunId?: (runId: string) => void;
}

export function TriageDetailModal({
  item,
  actions,
  onClose,
  onNavigate,
  currentIndex,
  totalCount,
  decisions,
  onApproveDecision,
  onRejectDecision,
  onFocusRunId,
}: TriageDetailModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Find linked decision for embedded flow
  const linkedDecision = useMemo(() => {
    if (!item || item.kind !== 'decision_required' || !item.sourceDecisionId || !decisions) return null;
    return decisions.find((d) => d.id === item.sourceDecisionId) ?? null;
  }, [item, decisions]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!item) return;

    const handler = (e: KeyboardEvent) => {
      // Skip if focused in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key) {
        case 'j':
        case 'ArrowRight':
          e.preventDefault();
          onNavigate?.(1);
          break;
        case 'k':
        case 'ArrowLeft':
          e.preventDefault();
          onNavigate?.(-1);
          break;
        case 'a':
          e.preventDefault();
          handleAction('approve');
          break;
        case 'd':
          e.preventDefault();
          handleAction('dismiss');
          break;
        case 'r':
          e.preventDefault();
          handleAction('retry');
          break;
        case 's':
          e.preventDefault();
          handleAction('snooze');
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onNavigate, onClose]);

  useEffect(() => {
    setTerminalError(null);
    setIsOpeningTerminal(false);
  }, [item?.id]);

  const handleAction = useCallback(
    async (action: string, note?: string) => {
      if (!item) return;
      try {
        await actions.performAction(item.id, action, { note });
        // Auto-advance after action
        onNavigate?.(1);
      } catch {
        // error handled by hook
      }
    },
    [item, actions, onNavigate]
  );

  const handleOpenTerminal = useCallback(async (logRef: string) => {
    const trimmed = logRef.trim();
    const leaf = trimmed.split(/[\\/]/).pop() ?? '';
    const runId = leaf.replace(/\.(log|output\.json)$/i, '').trim();

    try {
      setTerminalError(null);
      setIsOpeningTerminal(true);
      const response = await fetch('/orgx/api/live/terminal/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: runId || undefined,
          logPath: trimmed || undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Terminal open failed (${response.status})`
        );
      }
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : 'Unable to open terminal');
    } finally {
      setIsOpeningTerminal(false);
    }
  }, []);

  if (!item) return null;
  const terminalTarget = inferTerminalTarget(item);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={item.id}
        ref={containerRef}
        initial={{ opacity: 0, x: 44, scale: 0.985 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: -44, scale: 0.985 }}
        transition={{ duration: 0.28 }}
        className="flex h-full min-h-0 flex-col overflow-y-auto px-5 pb-5 pt-4"
      >
        {/* Navigation bar */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {onNavigate && (
              <>
                <button
                  type="button"
                  onClick={() => onNavigate(-1)}
                  className="rounded p-1 text-muted hover:text-secondary hover:bg-white/[0.06] transition-colors"
                  title="Previous (k)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate(1)}
                  className="rounded p-1 text-muted hover:text-secondary hover:bg-white/[0.06] transition-colors"
                  title="Next (j)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </>
            )}
            {currentIndex != null && totalCount != null && (
              <span className="text-micro text-muted tabular-nums">
                {currentIndex + 1} of {totalCount}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:text-secondary hover:bg-white/[0.06] transition-colors"
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 1. Hero — lineage first, then title + severity */}
        {(item.initiativeTitle || item.workstreamTitle) && (
          <p className="text-micro text-muted mb-1">
            {[item.initiativeTitle, item.workstreamTitle, item.taskTitle]
              .filter(Boolean)
              .join(' \u203A ')}
          </p>
        )}
        <div className="mb-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-heading font-semibold text-primary">
              {item.title}
            </h3>
            <span
              className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                backgroundColor: `${severityColor(item.severity)}20`,
                color: severityColor(item.severity),
              }}
            >
              {kindLabel(item.kind)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-caption text-secondary">
            {item.agentId && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-micro font-medium text-secondary">
                {item.agentId}
              </span>
            )}
            {item.occurrenceCount > 1 && (
              <span className="text-micro text-muted">
                x{item.occurrenceCount} occurrences
              </span>
            )}
          </div>
          <p className="text-body text-secondary leading-relaxed">
            {item.summary}
          </p>
        </div>

        {/* Scope context */}
        {(item.initiativeId || item.workstreamId) && (
          <div className="mb-3">
            <ScopeProgressCard
              nodes={buildScopeFromContext({
                initiativeId: item.initiativeId,
                initiativeTitle: item.initiativeTitle,
                workstreamId: item.workstreamId,
                workstreamTitle: item.workstreamTitle,
                taskId: item.taskId,
                taskTitle: item.taskTitle,
                agentName: item.agentId,
                status: item.status,
              })}
              activeId={item.taskId ?? item.workstreamId}
              compact
            />
          </div>
        )}

        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent mb-4" />

        {/* 2. Recommended action callout — promoted above actions */}
        {item.recommendedAction && (
          <div className="mb-4 rounded-xl border border-cyan-300/[0.28] bg-cyan-500/[0.12] px-4 py-3">
            <p className="text-micro font-semibold uppercase tracking-wider text-cyan-200 mb-1">
              Recommended
            </p>
            <p className="text-body text-cyan-100">{item.recommendedAction}</p>
          </div>
        )}

        {/* 3. Proof / Evidence */}
        <div className="space-y-4 mb-4">
          <ProofSection
            item={item}
            onOpenTerminal={handleOpenTerminal}
          />
        </div>

        {/* 4. Impact */}
        <div className="mb-4">
          <ImpactSection item={item} />
        </div>

        {/* 5. Embedded decision flow */}
        {linkedDecision && (
          <div className="mb-4">
            <SectionHeading>Linked Decision</SectionHeading>
            <EmbeddedDecisionFlow
              decision={linkedDecision}
              onApprove={onApproveDecision}
              onReject={onRejectDecision}
            />
          </div>
        )}

        {/* 6. Lifecycle timeline */}
        <div className="mb-4">
          <LifecycleTimeline item={item} />
        </div>

        {/* 7. Actions */}
        <div className="mb-4">
          <div className="space-y-1.5">
            {item.actionContract.map((action) => (
              <ActionButton
                key={action.action}
                triageAction={action}
                onPerform={handleAction}
                isActing={actions.isActing}
              />
            ))}
          </div>
          {terminalTarget && !item.proofBundle.logRefs.length && (
            <button
              type="button"
              onClick={async () => {
                try {
                  setTerminalError(null);
                  setIsOpeningTerminal(true);
                  const response = await fetch('/orgx/api/live/terminal/open', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      runId: terminalTarget.runId,
                      logPath: terminalTarget.logPath,
                    }),
                  });
                  if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw new Error(
                      (body as { error?: string }).error ?? `Terminal open failed (${response.status})`
                    );
                  }
                } catch (error) {
                  setTerminalError(error instanceof Error ? error.message : 'Unable to open terminal');
                } finally {
                  setIsOpeningTerminal(false);
                }
              }}
              disabled={isOpeningTerminal}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-50"
            >
              <span className="font-mono text-micro">{`>_`}</span>
              {isOpeningTerminal ? 'Opening\u2026' : 'Open in terminal'}
            </button>
          )}
          {terminalError ? <p className="mt-2 text-micro text-red-200">{terminalError}</p> : null}
        </div>

        {/* 8. Source run link */}
        {onFocusRunId && (item.sourceActivityId || item.sourceDecisionId) && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => {
                // Try to infer a runId from terminal target or source IDs
                const runId = terminalTarget?.runId ?? item.sourceActivityId ?? item.sourceDecisionId;
                if (runId) onFocusRunId(runId);
              }}
              className="inline-flex items-center gap-1.5 text-caption text-[#D8FFA1] transition-colors hover:text-white"
            >
              <EntityIcon type="session" size={12} />
              View source run
            </button>
          </div>
        )}

        {/* 9. Technical details (collapsed) */}
        <TechnicalDetails item={item} />

        {/* Keyboard shortcuts hint */}
        <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted opacity-60">
          <span>j/k nav</span>
          <span>a approve</span>
          <span>d dismiss</span>
          <span>r retry</span>
          <span>s snooze</span>
          <span>esc close</span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
