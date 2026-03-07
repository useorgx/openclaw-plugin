import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { formatDurationWithUrgency, formatRelativeTime } from '@/lib/time';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { EvidenceCard } from '@/components/shared/EvidenceCard';
import { BreadcrumbNav } from '@/components/shared/BreadcrumbNav';
import { ScopeProgressCard, buildScopeFromContext } from '@/components/shared/ScopeProgressCard';
import { humanizeWarning } from '@/lib/humanize';
import { humanizeDecisionContext, suggestedOptionsToLiveOptions } from '@/lib/humanize-decision-context';
import { computeDecisionImpact, formatDecisionImpact, type MissionControlGraphRef } from '@/lib/compute-decision-impact';
import { motion, AnimatePresence } from 'framer-motion';
import type { LiveDecision, LiveDecisionOption } from '@/types';

type DecisionActionSummary = {
  updated: number;
  failed: number;
  firstError?: string;
};

type DecisionActionInput = {
  note?: string;
  optionId?: string;
};

interface DecisionDetailModalProps {
  open: boolean;
  decision: LiveDecision | null;
  onClose: () => void;
  onApprove?: (
    decisionId: string,
    input?: DecisionActionInput
  ) => Promise<DecisionActionSummary>;
  onReject?: (
    decisionId: string,
    input?: DecisionActionInput
  ) => Promise<DecisionActionSummary>;
  // New props
  initiativeTitle?: string | null;
  workstreamTitle?: string | null;
  onNavigate?: (direction: 1 | -1) => void;
  currentIndex?: number;
  totalCount?: number;
  onFocusRunId?: (runId: string) => void;
  /** Mission control graph for impact computation (optional) */
  graph?: MissionControlGraphRef | null;
}

type ModalPhase = 'idle' | 'approving' | 'rejecting' | 'success' | 'rejected' | 'error';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function normalizeOptionStatus(
  value: unknown
): LiveDecisionOption['impliedStatus'] {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'rejected') return 'declined';
  if (
    normalized === 'approved' ||
    normalized === 'declined' ||
    normalized === 'cancelled'
  ) {
    return normalized;
  }
  return null;
}

function formatDecisionActionError(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const message = humanizeWarning(raw.trim());
  return message || fallback;
}

function decisionTypeLabel(decisionType: string): string {
  switch (decisionType) {
    case 'spawn_guard_blocked': return 'Spawn Guard';
    case 'autopilot_failure': return 'Autopilot Failure';
    case 'budget_exceeded': return 'Budget Exceeded';
    case 'scope_change': return 'Scope Change';
    case 'conflict_resolution': return 'Conflict Resolution';
    case 'approval_required': return 'Approval Required';
    case 'review_required': return 'Review Required';
    case 'permission_request': return 'Permission Request';
    default: return decisionType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function priorityColor(priority: string): string {
  const lower = priority.toLowerCase();
  if (lower === 'critical' || lower === 'p0') return colors.red;
  if (lower === 'high' || lower === 'p1') return colors.amber;
  if (lower === 'medium' || lower === 'p2') return colors.iris;
  return 'rgba(255,255,255,0.5)';
}

export function DecisionDetailModal({
  open,
  decision,
  onClose,
  onApprove,
  onReject,
  initiativeTitle,
  workstreamTitle,
  onNavigate,
  currentIndex,
  totalCount,
  onFocusRunId,
  graph,
}: DecisionDetailModalProps) {
  const [phase, setPhase] = useState<ModalPhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // showNotes is derived below (after selectedOptionRecord is defined)
  const [copied, setCopied] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  // Stable ref to onClose so the auto-close timer always calls the latest version
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Reset state when decision changes or modal opens/closes
  useEffect(() => {
    if (open) {
      setPhase('idle');
      setErrorMessage(null);
      const defaultOptionId =
        decision?.selectedOptionId ??
        (decision?.options && decision.options.length === 1
          ? decision.options[0].id
          : null);
      setSelectedOption(defaultOptionId);
      setNote('');
      setCopied(false);
      setShowTechnical(false);
    }
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
    };
  }, [open, decision?.id]);

  const metadata = decision?.metadata;

  const legacyOptions = useMemo(() => {
    if (!metadata) return [];
    const meta = metadata as Record<string, unknown>;
    const raw = meta.decision_options ?? meta.options ?? meta.actions ?? null;
    if (!Array.isArray(raw)) return [];
    const parsed: LiveDecisionOption[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      if (typeof item === 'string') {
        const label = item.trim();
        if (!label) continue;
        const id = `option-${index + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        parsed.push({
          id,
          label,
          description: null,
          impliedStatus: null,
          actionType: null,
          requiresNote: false,
        });
        continue;
      }

      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id =
        (typeof record.id === 'string' && record.id.trim()) ||
        (typeof record.option_id === 'string' && record.option_id.trim()) ||
        (typeof record.action_id === 'string' && record.action_id.trim()) ||
        `option-${index + 1}`;
      if (seen.has(id)) continue;

      const label =
        (typeof record.label === 'string' && record.label.trim()) ||
        (typeof record.title === 'string' && record.title.trim()) ||
        (typeof record.name === 'string' && record.name.trim()) ||
        (typeof record.action === 'string' && record.action.trim()) ||
        null;
      if (!label) continue;

      seen.add(id);
      parsed.push({
        id,
        label,
        description:
          typeof record.description === 'string' ? record.description : null,
        impliedStatus:
          normalizeOptionStatus(record.implied_status) ??
          normalizeOptionStatus(record.status),
        actionType:
          (typeof record.action_type === 'string' && record.action_type) ||
          (typeof record.type === 'string' && record.type) ||
          null,
        requiresNote:
          record.requires_note === true ||
          record.requiresNote === true ||
          record.note_required === true,
      });
    }

    return parsed.slice(0, 12);
  }, [metadata]);

  // Humanize raw decision context for operator display
  const humanized = useMemo(() => {
    if (!decision) return null;
    return humanizeDecisionContext(decision);
  }, [decision?.context, decision?.title, decision?.decisionType]);

  // Impact computation from graph
  const impact = useMemo(() => {
    if (!decision) return null;
    return computeDecisionImpact(decision, graph ?? null);
  }, [decision?.workstreamId, decision?.initiativeId, graph]);

  // Urgency escalation: decisions waiting > 24h get extra visual treatment
  const isUrgent = (decision?.waitingMinutes ?? 0) > 1440;

  const options = useMemo(() => {
    if (decision?.options && decision.options.length > 0) {
      return decision.options;
    }
    if (legacyOptions.length > 0) return legacyOptions;
    // Auto-generate from humanized context when no options at all
    if (humanized && humanized.suggestedOptions.length > 0) {
      return suggestedOptionsToLiveOptions(humanized.suggestedOptions);
    }
    return [];
  }, [decision?.options, legacyOptions, humanized]);

  const selectedOptionRecord = useMemo(
    () => options.find((option) => option.id === selectedOption) ?? null,
    [options, selectedOption]
  );
  const showNotes = selectedOptionRecord?.requiresNote === true;

  const context = useMemo(() => {
    const value = (decision?.context ?? '').trim();
    if (value) return value;
    if (!metadata) return '';
    const meta = metadata as Record<string, unknown>;
    const fallback =
      (typeof meta.summary === 'string' ? meta.summary : null) ??
      (typeof meta.description === 'string' ? meta.description : null) ??
      '';
    return String(fallback ?? '').trim();
  }, [decision?.context, metadata]);

  const urgencyColor = useMemo(() => {
    const mins = decision?.waitingMinutes ?? 0;
    if (mins >= 15) return colors.red;
    if (mins >= 5) return colors.amber;
    return colors.teal;
  }, [decision?.waitingMinutes]);

  const copyDetails = useCallback(async () => {
    if (!decision) return;
    const payload = safeJson({ decision, metadata });
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silently fail */
    }
  }, [decision, metadata]);

  const buildActionInput = useCallback((): DecisionActionInput | undefined => {
    const trimmedNote = note.trim();
    const optionId = selectedOptionRecord?.id;
    if (!trimmedNote && !optionId) return undefined;
    return {
      note: trimmedNote.length > 0 ? trimmedNote : undefined,
      optionId: optionId ?? undefined,
    };
  }, [note, selectedOptionRecord]);

  const handleApprove = useCallback(async () => {
    if (!decision || !onApprove) return;
    if (options.length > 0 && !selectedOptionRecord) {
      setErrorMessage('Select an option before approving this decision.');
      return;
    }
    if (selectedOptionRecord?.requiresNote && note.trim().length === 0) {
      setErrorMessage('A note is required for the selected option.');
      requestAnimationFrame(() => noteRef.current?.focus());
      return;
    }
    // Use functional setState to read latest phase without stale closure
    let shouldProceed = false;
    setPhase((prev) => {
      if (prev === 'approving' || prev === 'rejecting') return prev;
      shouldProceed = true;
      return 'approving';
    });
    if (!shouldProceed) return;

    setErrorMessage(null);
    try {
      const result = await onApprove(decision.id, buildActionInput());
      if (result.failed > 0) {
        setPhase('error');
        setErrorMessage(
          formatDecisionActionError(result.firstError, 'Approval failed. Please try again.')
        );
      } else {
        setPhase('success');
        autoCloseTimer.current = setTimeout(() => onCloseRef.current(), 800);
      }
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : '';
      setErrorMessage(formatDecisionActionError(raw, 'Approval failed.'));
    }
  }, [buildActionInput, decision, note, onApprove, options.length, selectedOptionRecord]);

  const handleReject = useCallback(async () => {
    if (!decision || !onReject) return;
    if (options.length > 0 && !selectedOptionRecord) {
      setErrorMessage('Select an option before rejecting this decision.');
      return;
    }
    if (selectedOptionRecord?.requiresNote && note.trim().length === 0) {
      setErrorMessage('A note is required for the selected option.');
      requestAnimationFrame(() => noteRef.current?.focus());
      return;
    }
    let shouldProceed = false;
    setPhase((prev) => {
      if (prev === 'approving' || prev === 'rejecting') return prev;
      shouldProceed = true;
      return 'rejecting';
    });
    if (!shouldProceed) return;

    setErrorMessage(null);
    try {
      const result = await onReject(decision.id, buildActionInput());
      if (result.failed > 0) {
        setPhase('error');
        setErrorMessage(
          formatDecisionActionError(result.firstError, 'Rejection failed. Please try again.')
        );
      } else {
        setPhase('rejected');
        autoCloseTimer.current = setTimeout(() => onCloseRef.current(), 800);
      }
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : '';
      setErrorMessage(formatDecisionActionError(raw, 'Rejection failed.'));
    }
  }, [buildActionInput, decision, note, onReject, options.length, selectedOptionRecord]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Enter to approve
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleApprove();
        return;
      }

      // Skip shortcuts when focused on input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key) {
        case 'j':
          e.preventDefault();
          onNavigate?.(1);
          break;
        case 'k':
          e.preventDefault();
          onNavigate?.(-1);
          break;
        case 'a':
          e.preventDefault();
          void handleApprove();
          break;
        case 'r':
          e.preventDefault();
          void handleReject();
          break;
        case 'n':
          e.preventDefault();
          noteRef.current?.focus();
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, handleApprove, handleReject, onNavigate]);

  if (!open || !decision) return null;

  const busy = phase === 'approving' || phase === 'rejecting';
  const resolved = phase === 'success' || phase === 'rejected';
  const status = (decision.status ?? 'pending').toLowerCase();
  const isPending =
    !status.includes('approved') &&
    !status.includes('resolved') &&
    !status.includes('rejected') &&
    !status.includes('declined') &&
    !status.includes('cancelled');
  const missingOption = options.length > 0 && !selectedOptionRecord;
  const missingRequiredNote =
    selectedOptionRecord?.requiresNote === true && note.trim().length === 0;
  const disableActions = busy || missingOption || missingRequiredNote;

  const evidenceRefs = decision.evidenceRefs ?? [];
  const hasEvidence = evidenceRefs.length > 0;
  const recommendedAction = decision.recommendedAction ?? null;
  const decisionType = decision.decisionType ?? null;
  const priority = decision.priority ?? null;
  const occurrenceCount = decision.occurrenceCount ?? null;
  const sourceRunId = decision.sourceRunId ?? null;

  // Breadcrumb segments
  const breadcrumbSegments = [];
  if (initiativeTitle) breadcrumbSegments.push({ label: initiativeTitle, icon: 'initiative' as const });
  if (workstreamTitle) breadcrumbSegments.push({ label: workstreamTitle, icon: 'workstream' as const });

  // Technical details
  const technicalDetails = [
    ['ID', decision.id],
    ['Type', decision.decisionType],
    ['Dedupe key', decision.dedupeKey],
    ['Source system', decision.sourceSystem],
    ['Conflict source', decision.conflictSource],
    ['Agent ID', decision.agentId],
    ['Source run', decision.sourceRunId],
    ['Source session', decision.sourceSessionId],
    ['Source stream', decision.sourceStreamId],
  ].filter(([, v]) => v != null) as [string, string][];

  // Success / rejected overlay
  if (resolved) {
    const isApproval = phase === 'success';
    const accent = isApproval ? colors.lime : colors.red;
    return (
      <Modal open={open} onClose={onClose} maxWidth="max-w-xl" fitContent>
        <div className="flex flex-col items-center justify-center px-8 py-12">
          <div
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
            style={{
              backgroundColor: `${accent}18`,
              border: `1.5px solid ${accent}40`,
            }}
          >
            {isApproval ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            )}
          </div>
          <p className="text-heading font-semibold text-white">
            {isApproval ? 'Approved' : 'Rejected'}
          </p>
          <p className="mt-1 text-body text-secondary">
            {decision.title}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-xl">
      <div
        className="flex h-full min-h-0 w-full flex-col"
        style={isUrgent ? {
          boxShadow: `inset 0 0 0 1px ${colors.amber}30`,
          borderRadius: 'inherit',
        } : undefined}
      >
        {/* 1. Urgency accent line */}
        <div
          className="h-[2px] w-full flex-shrink-0"
          style={{ background: `linear-gradient(90deg, ${urgencyColor}60, ${urgencyColor}20, transparent)` }}
        />

        {/* 2. Navigation bar */}
        {onNavigate && (
          <div className="flex items-center justify-between px-6 pt-3 pb-0">
            <div className="flex items-center gap-2">
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
              {currentIndex != null && totalCount != null && (
                <span className="text-micro text-muted tabular-nums">
                  {currentIndex + 1} of {totalCount}
                  <span className="ml-1 hidden sm:inline">&middot; Longest waiting first</span>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-muted hover:text-secondary hover:bg-white/[0.06] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* 3. Scope breadcrumb */}
        {breadcrumbSegments.length > 0 && (
          <div className="px-6 pt-2">
            <BreadcrumbNav segments={breadcrumbSegments} />
          </div>
        )}

        {/* 4. Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-4 pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: `${urgencyColor}14`,
                  border: `1px solid ${urgencyColor}30`,
                }}
              >
                <EntityIcon type="decision" size={14} />
              </div>
              <div className="min-w-0">
                <h2 className="text-title font-medium leading-tight text-white mb-2">
                  {decision.title || 'Decision Required'}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-body text-secondary">
                  <span>{decision.agentName || 'OrgX Autopilot'}</span>
                  <span className="text-white/[0.15]">|</span>
                  <span className={isUrgent ? 'font-semibold text-red-300' : ''}>
                    {formatDurationWithUrgency(decision.waitingMinutes).text}
                  </span>
                  {decisionType && (
                    <>
                      <span className="text-white/[0.15]">|</span>
                      <span className="text-primary">
                        {decisionTypeLabel(decisionType)}
                      </span>
                    </>
                  )}
                  {priority && (
                    <>
                      <span className="text-white/[0.15]">|</span>
                      <span
                        className="font-medium"
                        style={{ color: priorityColor(priority) }}
                      >
                        {priority}
                      </span>
                    </>
                  )}
                </div>
                {occurrenceCount != null && occurrenceCount > 1 && (
                  <p className="mt-2 text-caption text-muted">
                    Seen {occurrenceCount} times
                    {decision.firstSeenAt && <> · first {formatRelativeTime(decision.firstSeenAt)}</>}
                    {decision.lastSeenAt && <> · last {formatRelativeTime(decision.lastSeenAt)}</>}
                  </p>
                )}
              </div>
            </div>
          </div>
          {!onNavigate && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {/* 4b. Scope context */}
          {(decision.initiativeId || decision.workstreamId) && (
            <div className="mb-4">
              <ScopeProgressCard
                nodes={buildScopeFromContext({
                  initiativeId: decision.initiativeId,
                  initiativeTitle: initiativeTitle,
                  workstreamId: decision.workstreamId,
                  workstreamTitle: workstreamTitle,
                  agentName: decision.agentName,
                  agentId: decision.agentId,
                })}
                activeId={decision.workstreamId}
                compact
              />
            </div>
          )}

          {/* 5. Recommended action callout */}
          {recommendedAction && (
            <div className="mb-4 rounded-xl border border-cyan-300/[0.28] bg-cyan-500/[0.12] px-4 py-3">
              <p className="text-micro font-semibold uppercase tracking-wider text-cyan-200 mb-1">
                Recommended
              </p>
              <p className="text-body text-cyan-100">{recommendedAction}</p>
            </div>
          )}

          {/* 6. Evidence section */}
          {hasEvidence && (
            <div className="mb-4">
              <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                Evidence
              </p>
              <div className="space-y-1.5">
                {evidenceRefs.map((ref, i) => (
                  <EvidenceCard
                    key={i}
                    evidenceType={ref.evidenceType}
                    title={ref.title}
                    summary={ref.summary}
                    sourceUrl={ref.sourceUrl}
                    confidence={ref.confidence}
                    payload={ref.payload}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 6b. Urgency callout for long-waiting decisions */}
          {isUrgent && (
            <div className="mb-4 rounded-xl border border-amber-400/[0.3] bg-amber-500/[0.08] px-4 py-3">
              <p className="text-body text-amber-200">
                This decision has been waiting{' '}
                <span className="font-semibold text-amber-100">
                  {formatDurationWithUrgency(decision.waitingMinutes).text}
                </span>
                . Downstream work is paused.
              </p>
            </div>
          )}

          {/* 7. Context — humanized when raw, verbatim when rich */}
          {humanized && humanized.headline !== decision.title ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <p className="text-micro font-semibold uppercase tracking-wider text-muted mb-2">What happened</p>
              <p className="text-body text-primary leading-relaxed">{humanized.explanation}</p>
              {Object.keys(humanized.structuredDetails).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-secondary">
                  {Object.entries(humanized.structuredDetails)
                    .filter(([, v]) => v != null)
                    .map(([k, v]) => (
                      <span key={k}>
                        {k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}: {v}
                      </span>
                    ))}
                </div>
              )}
            </div>
          ) : context ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <MarkdownText text={context} mode="block" />
            </div>
          ) : (
            <p className="px-1 text-body text-muted italic">
              No additional context provided.
            </p>
          )}

          {/* 8. Options as selectable cards */}
          {options.length > 0 && (
            <div className="mt-8">
              <p className="mb-3 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                Options
              </p>
              <div className="space-y-1 relative">
                {options.map((option) => {
                  const isActive = selectedOption === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setSelectedOption(isActive ? null : option.id);
                        if (option.requiresNote) {
                          requestAnimationFrame(() => noteRef.current?.focus());
                        }
                      }}
                      disabled={busy}
                      className="group relative flex w-full items-start gap-4 px-4 py-4 text-left focus:outline-none"
                    >
                      {isActive && (
                        <motion.div
                          layoutId="decision-option-bg"
                          className="absolute inset-0 rounded-xl"
                          style={{ backgroundColor: `${colors.lime}12` }}
                          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                        />
                      )}
                      
                      {!isActive && (
                        <div className="absolute inset-0 rounded-xl opacity-0 transition-opacity group-hover:bg-white/[0.03]" />
                      )}

                      <div
                        className="relative mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
                        style={{
                          borderColor: isActive ? colors.lime : 'rgba(255,255,255,0.2)',
                        }}
                      >
                        <AnimatePresence>
                          {isActive && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              exit={{ scale: 0 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: colors.lime }}
                            />
                          )}
                        </AnimatePresence>
                      </div>
                      
                      <div className="relative min-w-0 flex-1">
                        <span className={`block text-[15px] ${isActive ? 'font-medium text-white' : 'text-primary'}`}>
                          {option.label}
                        </span>
                        {option.description && (
                          <p className="mt-1 text-[13px] leading-relaxed text-secondary">{option.description}</p>
                        )}
                        {option.requiresNote && (
                          <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-400">
                            Note required
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 9. Note field — only when an option requires a note */}
          {isPending && showNotes && (
            <div className="mt-4">
              <textarea
                ref={noteRef}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={busy}
                placeholder="Required: add context for this decision..."
                rows={3}
                className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-body text-primary placeholder-white/30 outline-none transition-colors focus:border-white/[0.16] focus:bg-white/[0.04]"
              />
              {note.trim().length === 0 && (
                <p className="mt-2 text-caption text-amber-300">
                  This option requires a note before submission.
                </p>
              )}
            </div>
          )}

          {/* 10. Impact section */}
          {impact && (
            <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <p className="text-micro font-semibold uppercase tracking-wider text-muted mb-2">Impact</p>
              <p className="text-body text-primary leading-relaxed">
                {formatDecisionImpact(impact)}
              </p>
              {impact.blockedWorkstreams.length > 0 && (
                <ul className="mt-2 space-y-1 text-caption text-secondary">
                  {impact.blockedWorkstreams.map((ws) => (
                    <li key={ws.id} className="flex items-center gap-2">
                      <span className="inline-block h-1 w-1 rounded-full bg-amber-400 flex-shrink-0" />
                      {ws.title}
                      {ws.status === 'blocked' && (
                        <span className="text-amber-400 text-micro">(blocked)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 11. Source trace link */}
          {sourceRunId && onFocusRunId && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => onFocusRunId(sourceRunId)}
                className="inline-flex items-center gap-1.5 text-caption text-[#D8FFA1] transition-colors hover:text-white"
              >
                <EntityIcon type="session" size={12} />
                View source run
              </button>
            </div>
          )}

          {/* 12. Comments thread */}
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <EntityCommentsPanel entityType="decision" entityId={decision.id} />
          </div>

          {/* 13. Technical details (collapsed) */}
          {technicalDetails.length > 0 && (
            <div className="mt-4 border-t border-white/[0.06] pt-2">
              <button
                type="button"
                onClick={() => setShowTechnical((o) => !o)}
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
                  className={`transition-transform ${showTechnical ? 'rotate-180' : ''}`}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {showTechnical && (
                <div className="mt-2 space-y-0.5">
                  {technicalDetails.map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-micro">
                      <span className="text-muted w-28 flex-shrink-0">{k}</span>
                      <span className="text-secondary truncate">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 14. Keyboard hints */}
          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted opacity-60">
            {onNavigate && <span>j/k nav</span>}
            <span>a approve</span>
            <span>r reject</span>
            <span>n note</span>
            <span>{isMac ? '\u2318' : 'Ctrl'}+Enter approve</span>
            <span>esc close</span>
          </div>
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-6 py-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" x2="12" y1="8" y2="12" />
              <line x1="12" x2="12.01" y1="16" y2="16" />
            </svg>
            <p className="text-caption text-red-300">{errorMessage}</p>
          </div>
        )}

        {/* 15. Action footer - only for pending decisions */}
        {isPending && (
          <div className="relative mt-auto border-t border-white/[0.04] bg-black/60 px-6 py-5 backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Reject */}
                {onReject && (
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    type="button"
                    onClick={handleReject}
                    disabled={disableActions}
                    className="rounded-lg px-4 py-2 text-[14px] font-medium text-secondary transition-colors hover:text-red-400 disabled:opacity-40 focus:outline-none"
                  >
                    {phase === 'rejecting' ? (
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                        Rejecting
                      </span>
                    ) : (
                      'Reject'
                    )}
                  </motion.button>
                )}
                <button
                  type="button"
                  onClick={copyDetails}
                  className="rounded-lg px-2 py-2 text-[13px] text-muted transition-colors hover:text-secondary focus:outline-none"
                  title="Copy decision as JSON"
                >
                  {copied ? 'Copied' : 'Copy JSON'}
                </button>
              </div>
              <div className="flex items-center gap-4">
                <span className="hidden text-[13px] text-muted sm:block">
                  {isMac ? '\u2318' : 'Ctrl'}+Enter
                </span>
                <motion.button
                  whileTap={(!onApprove || disableActions) ? undefined : { scale: 0.97 }}
                  type="button"
                  onClick={handleApprove}
                  disabled={!onApprove || disableActions}
                  data-modal-autofocus="true"
                  className="rounded-lg px-6 py-2.5 text-[14px] font-semibold transition-all focus:outline-none"
                  style={{
                    backgroundColor: (!onApprove || disableActions) ? 'rgba(255,255,255,0.06)' : colors.lime,
                    color: (!onApprove || disableActions) ? 'rgba(255,255,255,0.4)' : '#000',
                  }}
                >
                  {phase === 'approving' ? (
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-black/40 border-t-black" />
                      Approving
                    </span>
                  ) : (
                    'Approve'
                  )}
                </motion.button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
