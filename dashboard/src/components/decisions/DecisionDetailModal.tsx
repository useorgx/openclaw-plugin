import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { formatDurationWithUrgency } from '@/lib/time';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
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

export function DecisionDetailModal({
  open,
  decision,
  onClose,
  onApprove,
  onReject,
}: DecisionDetailModalProps) {
  const [phase, setPhase] = useState<ModalPhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [copied, setCopied] = useState(false);
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
      setShowNotes(false);
      setCopied(false);
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

  const options = useMemo(() => {
    if (decision?.options && decision.options.length > 0) {
      return decision.options;
    }
    return legacyOptions;
  }, [decision?.options, legacyOptions]);

  const selectedOptionRecord = useMemo(
    () => options.find((option) => option.id === selectedOption) ?? null,
    [options, selectedOption]
  );

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
      setShowNotes(true);
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
        setErrorMessage(result.firstError ?? 'Approval failed. Please try again.');
      } else {
        setPhase('success');
        autoCloseTimer.current = setTimeout(() => onCloseRef.current(), 800);
      }
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Approval failed.');
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
      setShowNotes(true);
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
        setErrorMessage(result.firstError ?? 'Rejection failed. Please try again.');
      } else {
        setPhase('rejected');
        autoCloseTimer.current = setTimeout(() => onCloseRef.current(), 800);
      }
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Rejection failed.');
    }
  }, [buildActionInput, decision, note, onReject, options.length, selectedOptionRecord]);

  // Keyboard: Cmd/Ctrl+Enter to approve
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleApprove();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, handleApprove]);

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
      <div className="flex h-full min-h-0 w-full flex-col">
        {/* Urgency accent line */}
        <div
          className="h-[2px] w-full flex-shrink-0"
          style={{ background: `linear-gradient(90deg, ${urgencyColor}60, ${urgencyColor}20, transparent)` }}
        />

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4">
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
                <h2 className="text-heading font-semibold leading-tight text-white">
                  {decision.title || 'Decision'}
                </h2>
                <p className="mt-0.5 text-caption text-secondary">
                  {decision.agentName || 'OrgX Autopilot'}
                  {' \u00b7 '}
                  {formatDurationWithUrgency(decision.waitingMinutes).text}
                </p>
              </div>
            </div>
          </div>
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
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {/* Context */}
          {context ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <MarkdownText text={context} mode="block" />
            </div>
          ) : (
            <p className="px-1 text-body text-muted italic">
              No additional context provided.
            </p>
          )}

          {/* Options as selectable cards */}
          {options.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 px-1 text-micro font-medium uppercase tracking-[0.1em] text-muted">
                Options
              </p>
              <div className="space-y-1.5">
                {options.map((option) => {
                  const isActive = selectedOption === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setSelectedOption(isActive ? null : option.id);
                        if (option.requiresNote) {
                          setShowNotes(true);
                        }
                      }}
                      disabled={busy}
                      className="flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all"
                      style={{
                        borderColor: isActive ? `${colors.lime}50` : 'rgba(255,255,255,0.06)',
                        backgroundColor: isActive ? `${colors.lime}08` : 'rgba(255,255,255,0.02)',
                      }}
                    >
                      {/* Radio indicator */}
                      <div
                        className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors"
                        style={{
                          borderColor: isActive ? colors.lime : 'rgba(255,255,255,0.2)',
                        }}
                      >
                        {isActive && (
                          <div
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: colors.lime }}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className={`text-body ${isActive ? 'font-medium text-white' : 'text-primary'}`}>
                          {option.label}
                        </span>
                        {option.description && (
                          <p className="mt-0.5 text-caption text-secondary">{option.description}</p>
                        )}
                        {option.requiresNote && (
                          <p className="mt-1 text-micro uppercase tracking-[0.08em] text-amber-300">
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

          {/* Note field - expandable */}
          {isPending && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => {
                  setShowNotes((prev) => !prev);
                  if (!showNotes) {
                    requestAnimationFrame(() => noteRef.current?.focus());
                  }
                }}
                className="flex w-full items-center gap-2 px-1 text-caption text-secondary transition-colors hover:text-white"
              >
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform"
                  style={{ transform: showNotes ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Add a note
              </button>
              {showNotes && (
                <div className="mt-2">
                  <textarea
                    ref={noteRef}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={busy}
                    placeholder="Optional context for this decision..."
                    rows={3}
                    className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-body text-primary placeholder-white/30 outline-none transition-colors focus:border-white/[0.16] focus:bg-white/[0.04]"
                  />
                  {selectedOptionRecord?.requiresNote && note.trim().length === 0 && (
                    <p className="mt-2 text-caption text-amber-300">
                      This option requires a note before submission.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Comments thread */}
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <EntityCommentsPanel entityType="decision" entityId={decision.id} />
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

        {/* Action footer - only for pending decisions */}
        {isPending && (
          <div className="flex items-center justify-between border-t border-white/[0.06] px-6 py-4">
            <div className="flex items-center gap-2">
              {/* Reject */}
              {onReject && (
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={disableActions}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-body font-medium text-secondary transition-all hover:border-red-400/30 hover:bg-red-400/[0.08] hover:text-red-300 disabled:opacity-40"
                >
                  {phase === 'rejecting' ? (
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Rejecting
                    </span>
                  ) : (
                    'Reject'
                  )}
                </button>
              )}
              {/* Copy JSON - minimal */}
              <button
                type="button"
                onClick={copyDetails}
                className="rounded-lg px-3 py-2 text-caption text-muted transition-colors hover:text-white"
                title="Copy decision as JSON"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-micro text-muted sm:block">
                {isMac ? '\u2318' : 'Ctrl'}+Enter
              </span>
              <button
                type="button"
                onClick={handleApprove}
                disabled={!onApprove || disableActions}
                data-modal-autofocus="true"
                className="rounded-lg px-5 py-2 text-body font-semibold transition-all"
                style={{
                  backgroundColor:
                    !onApprove || disableActions ? 'rgba(255,255,255,0.08)' : colors.lime,
                  color: !onApprove || disableActions ? 'rgba(255,255,255,0.4)' : '#000',
                  boxShadow:
                    !onApprove || disableActions ? 'none' : `0 0 20px ${colors.lime}20`,
                }}
              >
                {phase === 'approving' ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/40 border-t-black" />
                    Approving
                  </span>
                ) : (
                  'Approve'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
