import { useState, useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LiveDecision, LiveTriageItem, TriageAction } from '@/types';
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

function missingInterventionFields(item: LiveTriageItem): string[] {
  const context = item.intervention;
  const missing = new Set<string>();

  if (!context) {
    missing.add('Intervention brief');
    return Array.from(missing);
  }

  const hasEvidence =
    (Array.isArray(context.evidence) && context.evidence.length > 0) ||
    item.proofBundle.artifactRefs.length > 0 ||
    item.proofBundle.logRefs.length > 0 ||
    item.proofBundle.prRefs.length > 0 ||
    item.proofBundle.fileChanges.length > 0;
  const hasScope = Array.isArray(context.scopeHierarchy) && context.scopeHierarchy.length > 0;
  const hasAction = Boolean(context.requiredAction) || Boolean(context.recommendedAction);

  if (item.kind === 'decision_required' || item.kind === 'review_required') {
    if (!context.decisionPrompt && !context.decisionSummary) missing.add('Decision prompt');
    if (!Array.isArray(context.decisionOptions) || context.decisionOptions.length === 0) {
      missing.add('Decision options');
    }
    if (!hasAction) missing.add('Recommended action');
    if (!hasEvidence) missing.add('Supporting evidence');
    if (!hasScope) missing.add('Affected scope');
    return Array.from(missing);
  }

  if (!context.blockerReason && !item.summary) missing.add('Blocker reason');
  if (!hasAction) missing.add('Required action');
  if (!context.waitingOn && !context.currentRunState) missing.add('What is blocked');
  if (!hasEvidence) missing.add('Supporting evidence');
  if (!hasScope) missing.add('Affected scope');
  return Array.from(missing);
}

function IncompleteSignalNotice({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-3.5 py-3">
      <p className="text-micro font-semibold uppercase tracking-wider text-amber-100">
        Signal incomplete
      </p>
      <p className="mt-1 text-caption text-amber-50/90">
        This intervention is missing context the operator needs to act cleanly.
      </p>
      <ul className="mt-2 space-y-0.5">
        {missing.map((field) => (
          <li key={field} className="text-caption text-amber-100/85">
            - {field}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-micro text-amber-100/60">
        Raw diagnostics remain available under Technical details.
      </p>
    </div>
  );
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

function InterventionSection({ item }: { item: LiveTriageItem }) {
  const context = item.intervention;
  if (!context) return null;
  const hasContext =
    Boolean(context.blockerReason) ||
    Boolean(context.decisionPrompt) ||
    Boolean(context.decisionSummary) ||
    Boolean(context.waitingOn) ||
    Boolean(context.requiredAction) ||
    Boolean(context.recommendedAction) ||
    Boolean(context.requiredActor) ||
    Boolean(context.errorCode) ||
    Boolean(context.errorCategory) ||
    Boolean(context.currentRunState) ||
    Boolean(context.impactIfDelayed) ||
    typeof context.retryable === 'boolean' ||
    (Array.isArray(context.suggestedActions) && context.suggestedActions.length > 0) ||
    (Array.isArray(context.nextActions) && context.nextActions.length > 0) ||
    (Array.isArray(context.scopeHierarchy) && context.scopeHierarchy.length > 0) ||
    (Array.isArray(context.decisionOptions) && context.decisionOptions.length > 0) ||
    (Array.isArray(context.evidence) && context.evidence.length > 0) ||
    (Array.isArray(context.artifacts) && context.artifacts.length > 0) ||
    (Array.isArray(context.updatesApplied) && context.updatesApplied.length > 0) ||
    typeof context.taskUpdateCount === 'number' ||
    typeof context.milestoneUpdateCount === 'number';
  if (!hasContext) return null;

  return (
    <div>
      <SectionHeading>Intervention brief</SectionHeading>
      <div className="space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
        {Array.isArray(context.scopeHierarchy) && context.scopeHierarchy.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Scope</p>
            <p className="text-caption text-primary">{context.scopeHierarchy.join(' › ')}</p>
          </div>
        )}
        {context.decisionPrompt && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Decision prompt</p>
            <p className="text-caption text-primary">{context.decisionPrompt}</p>
            {context.decisionSummary && (
              <p className="mt-1 text-caption text-secondary">{context.decisionSummary}</p>
            )}
          </div>
        )}
        {context.blockerReason && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Blocker</p>
            <p className="text-caption text-primary">{context.blockerReason}</p>
          </div>
        )}
        {context.requiredAction && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Required action</p>
            <p className="text-caption text-[#7AEDE5]">{context.requiredAction}</p>
          </div>
        )}
        {context.recommendedAction && context.recommendedAction !== context.requiredAction && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Recommended</p>
            <p className="text-caption text-[#7AEDE5]">{context.recommendedAction}</p>
          </div>
        )}
        {context.waitingOn && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Waiting on</p>
            <p className="text-caption text-secondary">{context.waitingOn}</p>
          </div>
        )}
        {(context.currentRunState || context.impactIfDelayed) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {context.currentRunState && (
              <div>
                <p className="text-micro uppercase tracking-wider text-muted">Run state</p>
                <p className="text-caption text-secondary">{context.currentRunState}</p>
              </div>
            )}
            {context.impactIfDelayed && (
              <div>
                <p className="text-micro uppercase tracking-wider text-muted">Impact if delayed</p>
                <p className="text-caption text-secondary">{context.impactIfDelayed}</p>
              </div>
            )}
          </div>
        )}
        {(context.errorCode || context.errorCategory || typeof context.retryable === 'boolean') && (
          <div className="flex flex-wrap gap-2">
            {context.errorCode && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-micro text-secondary">
                Error: {context.errorCode}
              </span>
            )}
            {context.errorCategory && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-micro text-secondary">
                Category: {context.errorCategory}
              </span>
            )}
            {typeof context.retryable === 'boolean' && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-micro text-secondary">
                {context.retryable ? 'Retryable' : 'Non-retryable'}
              </span>
            )}
          </div>
        )}
        {Array.isArray(context.decisionOptions) && context.decisionOptions.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Options</p>
            <div className="mt-1.5 space-y-1.5">
              {context.decisionOptions.slice(0, 6).map((option, index) => (
                <div
                  key={`${option.id ?? option.label}-${index}`}
                  className="rounded-lg border border-white/[0.06] bg-black/[0.18] px-2.5 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-caption font-medium text-primary">{option.label}</p>
                    {option.recommended ? (
                      <span className="rounded-full bg-[#0AD4C4]/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#7AEDE5]">
                        Recommended
                      </span>
                    ) : null}
                  </div>
                  {option.description ? (
                    <p className="mt-1 text-caption text-secondary">{option.description}</p>
                  ) : null}
                  {option.consequences ? (
                    <p className="mt-1 text-micro text-muted">{option.consequences}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
        {((context.taskUpdateCount ?? 0) > 0 || (context.milestoneUpdateCount ?? 0) > 0) && (
          <div className="flex flex-wrap gap-2">
            {(context.taskUpdateCount ?? 0) > 0 && (
              <span className="rounded bg-[#0AD4C4]/12 px-1.5 py-0.5 text-micro text-[#7AEDE5]">
                {context.taskUpdateCount} task update{context.taskUpdateCount === 1 ? '' : 's'}
              </span>
            )}
            {(context.milestoneUpdateCount ?? 0) > 0 && (
              <span className="rounded bg-[#0AD4C4]/12 px-1.5 py-0.5 text-micro text-[#7AEDE5]">
                {context.milestoneUpdateCount} milestone update{context.milestoneUpdateCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
        {Array.isArray(context.updatesApplied) && context.updatesApplied.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Updates applied</p>
            <ul className="mt-1 space-y-0.5">
              {context.updatesApplied.slice(0, 4).map((update) => (
                <li key={update} className="text-caption text-secondary">- {update}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(context.artifacts) && context.artifacts.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Artifacts</p>
            <ul className="mt-1 space-y-0.5">
              {context.artifacts.slice(0, 4).map((artifact) => (
                <li key={artifact} className="text-caption text-secondary">- {artifact}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(context.evidence) && context.evidence.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Evidence</p>
            <div className="mt-1.5 space-y-1.5">
              {context.evidence.slice(0, 4).map((evidence, index) => (
                <div
                  key={`${evidence.title}-${index}`}
                  className="rounded-lg border border-white/[0.06] bg-black/[0.18] px-2.5 py-2"
                >
                  <p className="text-caption font-medium text-primary">{evidence.title}</p>
                  {evidence.summary ? (
                    <p className="mt-1 text-caption text-secondary">{evidence.summary}</p>
                  ) : null}
                  {(evidence.url || evidence.pointer) && (
                    <p className="mt-1 text-micro text-muted">
                      {evidence.url ? (
                        <a
                          href={evidence.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#7AEDE5] transition-colors hover:text-white"
                        >
                          Open source
                        </a>
                      ) : evidence.pointer}
                      {evidence.url && evidence.pointer ? ` · ${evidence.pointer}` : null}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {Array.isArray(context.suggestedActions) && context.suggestedActions.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Suggested actions</p>
            <ul className="mt-1 space-y-0.5">
              {context.suggestedActions.slice(0, 4).map((action) => (
                <li key={action} className="text-caption text-secondary">- {action}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(context.nextActions) && context.nextActions.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-muted">Next up</p>
            <ul className="mt-1 space-y-0.5">
              {context.nextActions.slice(0, 4).map((action) => (
                <li key={action} className="text-caption text-secondary">- {action}</li>
              ))}
            </ul>
          </div>
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
  onPerform: (action: string, note?: string, optionId?: string) => void;
  isActing: boolean;
}) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');

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
            onClick={() => onPerform(triageAction.action, note, triageAction.optionId ?? undefined)}
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
    <button
      type="button"
      onClick={() => {
        if (triageAction.requiresNote) {
          setShowNote(true);
        } else {
          onPerform(triageAction.action, undefined, triageAction.optionId ?? undefined);
        }
      }}
      disabled={isActing}
      className={`rounded-lg px-3 py-1.5 text-caption font-medium transition-colors disabled:opacity-40 ${baseClass}`}
      title={triageAction.consequences}
    >
      <span>{triageAction.label}</span>
      <span className="ml-1 text-micro opacity-60">— {triageAction.consequences}</span>
    </button>
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
  decisions?: LiveDecision[];
  onApproveDecision?: (
    decisionId: string,
    input?: { note?: string; optionId?: string }
  ) => Promise<{ updated: number; failed: number; firstError?: string }>;
  onRejectDecision?: (
    decisionId: string,
    input?: { note?: string; optionId?: string }
  ) => Promise<{ updated: number; failed: number; firstError?: string }>;
}

export function TriageDetailModal({
  item,
  actions,
  onClose,
  onNavigate,
  currentIndex,
  totalCount,
  decisions,
}: TriageDetailModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const defaultOptionByAction = useCallback(
    (action: string): string | undefined => {
      if (!item) return undefined;
      const match = item.actionContract.find(
        (entry) => entry.action === action && typeof entry.optionId === 'string' && entry.optionId.trim().length > 0
      );
      return typeof match?.optionId === 'string' ? match.optionId : undefined;
    },
    [item]
  );

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

  const handleAction = useCallback(
    async (action: string, note?: string, optionId?: string) => {
      if (!item) return;
      try {
        await actions.performAction(item.id, action, {
          note,
          optionId: optionId ?? defaultOptionByAction(action),
        });
        // Auto-advance after action
        onNavigate?.(1);
      } catch {
        // error handled by hook
      }
    },
    [item, actions, onNavigate, defaultOptionByAction]
  );

  if (!item) return null;

  const linkedDecision =
    item.sourceDecisionId && Array.isArray(decisions)
      ? decisions.find((decision) => decision.id === item.sourceDecisionId) ?? null
      : null;
  const incompleteFields = missingInterventionFields(item);

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
              .join(' › ')}
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
          {linkedDecision?.recommendedAction && (
            <p className="text-caption text-[#7AEDE5]">
              Recommended: {linkedDecision.recommendedAction}
            </p>
          )}
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent mb-4" />

        {/* 2. Proof */}
        <div className="space-y-4 mb-4">
          <IncompleteSignalNotice missing={incompleteFields} />
          <InterventionSection item={item} />
          <ProofSection item={item} />
        </div>

        {/* 3. Impact */}
        <div className="mb-4">
          <ImpactSection item={item} />
        </div>

        {/* 4. Actions */}
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
          {item.recommendedAction && (
            <p className="mt-2 text-micro text-[#7AEDE5]">
              Recommended: {item.recommendedAction}
            </p>
          )}
        </div>

        {/* 5. Technical details (collapsed) */}
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
