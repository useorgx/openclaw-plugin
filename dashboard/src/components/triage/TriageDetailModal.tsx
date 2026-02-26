import { useState, useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LiveTriageItem, TriageAction } from '@/types';
import type { TriageQueueActions } from '@/hooks/useTriageQueue';

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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-micro font-semibold uppercase tracking-wider text-muted mb-1.5">
      {children}
    </h4>
  );
}

function ProofSection({ item }: { item: LiveTriageItem }) {
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
      <SectionHeading>Proof</SectionHeading>
      <div className="space-y-1">
        {bundle.prRefs.map((ref, i) => (
          <ProofRow key={`pr-${i}`} icon="pr" label={ref} />
        ))}
        {bundle.fileChanges.map((ref, i) => (
          <ProofRow key={`file-${i}`} icon="file" label={ref} />
        ))}
        {bundle.artifactRefs.map((ref, i) => (
          <ProofRow key={`art-${i}`} icon="artifact" label={ref} />
        ))}
        {bundle.logRefs.map((ref, i) => (
          <ProofRow key={`log-${i}`} icon="log" label={ref} />
        ))}
        {bundle.decisionRefs.map((ref, i) => (
          <ProofRow key={`dec-${i}`} icon="decision" label={ref} />
        ))}
      </div>
    </div>
  );
}

function ProofRow({ icon, label }: { icon: string; label: string }) {
  const iconChar =
    icon === 'pr'
      ? '⎇'
      : icon === 'file'
        ? '◇'
        : icon === 'log'
          ? '▸'
          : icon === 'decision'
            ? '◈'
            : '▪';

  return (
    <div className="flex items-center gap-2 rounded bg-white/[0.03] px-2 py-1 text-caption text-secondary">
      <span className="text-muted flex-shrink-0 w-4 text-center">{iconChar}</span>
      <span className="truncate">{label}</span>
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

  return (
    <div>
      <SectionHeading>Impact if ignored</SectionHeading>
      <div className="flex flex-wrap gap-2">
        {impact.initiativeCount > 0 && (
          <ImpactChip
            label={`${impact.initiativeCount} initiative${impact.initiativeCount > 1 ? 's' : ''}`}
          />
        )}
        {impact.workstreamCount > 0 && (
          <ImpactChip
            label={`${impact.workstreamCount} workstream${impact.workstreamCount > 1 ? 's' : ''}`}
          />
        )}
        {impact.downstreamBlockedCount > 0 && (
          <ImpactChip
            label={`${impact.downstreamBlockedCount} blocked downstream`}
            tone="red"
          />
        )}
      </div>
    </div>
  );
}

function ImpactChip({
  label,
  tone = 'amber',
}: {
  label: string;
  tone?: 'amber' | 'red';
}) {
  const bg = tone === 'red' ? 'bg-[#FF6B6B]/14' : 'bg-[#F5B700]/14';
  const text = tone === 'red' ? 'text-[#FFA8A8]' : 'text-[#FFE7A8]';
  return (
    <span className={`rounded-full px-2 py-0.5 text-micro font-medium ${bg} ${text}`}>
      {label}
    </span>
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
      {isHovering && (
        <p className="px-1 text-micro text-secondary">{triageAction.consequences}</p>
      )}
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
// Main Modal
// ---------------------------------------------------------------------------

export interface TriageDetailModalProps {
  item: LiveTriageItem | null;
  actions: TriageQueueActions;
  onClose: () => void;
  onNavigate?: (direction: 1 | -1) => void;
  currentIndex?: number;
  totalCount?: number;
}

export function TriageDetailModal({
  item,
  actions,
  onClose,
  onNavigate,
  currentIndex,
  totalCount,
}: TriageDetailModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);

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

  if (!item) return null;

  const agentLabel = item.agentId ? `Agent ${item.agentId.slice(0, 8)}` : 'OrgX';
  const terminalPath = item.proofBundle.logRefs.find((ref) =>
    ref.startsWith('/') || ref.startsWith('~/') || ref.startsWith('file://')
  );

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

        {/* 1. What you're deciding */}
        <div className="mb-4">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                backgroundColor: `${severityColor(item.severity)}20`,
                color: severityColor(item.severity),
              }}
            >
              {kindLabel(item.kind)}
            </span>
            {item.occurrenceCount > 1 && (
              <span className="text-micro text-muted">
                ×{item.occurrenceCount} occurrences
              </span>
            )}
          </div>
          <div className="mb-2 inline-flex items-center gap-2 text-caption text-secondary">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-micro text-primary">
              {agentLabel.slice(0, 1)}
            </span>
            <span>{agentLabel}</span>
            {(item.initiativeTitle || item.workstreamTitle) && (
              <span className="truncate text-muted">
                {[item.initiativeTitle, item.workstreamTitle, item.taskTitle].filter(Boolean).join(' > ')}
              </span>
            )}
          </div>
          <h3 className="text-heading font-semibold text-primary mt-1">
            {item.title}
          </h3>
          <p className="mt-1 text-body text-secondary leading-relaxed">
            {item.summary}
          </p>
          <div className="mt-2 rounded-lg bg-white/[0.03] px-3 py-2 text-caption text-secondary">
            {item.summary}
          </div>
        </div>

        {/* 2. Proof */}
        <div className="space-y-4 mb-4">
          <ProofSection item={item} />
        </div>

        {/* 3. Impact */}
        <div className="mb-4">
          <ImpactSection item={item} />
        </div>

        {/* 4. Actions */}
        <div className="mb-4">
          <SectionHeading>Actions</SectionHeading>
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
          {item.recommendedAction && (
            <p className="mt-2 text-micro text-[#7AEDE5]">
              Recommended: {item.recommendedAction}
            </p>
          )}
          {terminalPath && (
            <button
              type="button"
              onClick={async () => {
                try {
                  setTerminalError(null);
                  setIsOpeningTerminal(true);
                  const response = await fetch('/orgx/api/live/terminal/open', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: terminalPath }),
                  });
                  if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw new Error((body as { error?: string }).error ?? 'Unable to open terminal');
                  }
                } catch (error) {
                  setTerminalError(error instanceof Error ? error.message : 'Unable to open terminal');
                } finally {
                  setIsOpeningTerminal(false);
                }
              }}
              disabled={isOpeningTerminal}
              className="control-pill mt-2 h-8 px-3 text-caption font-semibold"
            >
              <span className="mr-1">{`>_`}</span>
              {isOpeningTerminal ? 'Opening...' : 'Open in terminal'}
            </button>
          )}
          {terminalError ? <p className="mt-2 text-micro text-red-200">{terminalError}</p> : null}
        </div>

        {/* 5. Technical details (collapsed) */}
        <TechnicalDetails item={item} />

        {/* Keyboard shortcuts hint */}
        <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted opacity-60">
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">j</kbd>/<kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">k</kbd> nav</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">a</kbd> approve</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">d</kbd> dismiss</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">r</kbd> retry</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">s</kbd> snooze</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro">esc</kbd> close</span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
