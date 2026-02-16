import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import type { LiveDecision } from '@/types';

type DecisionActionSummary = {
  updated: number;
  failed: number;
};

interface DecisionDetailModalProps {
  open: boolean;
  decision: LiveDecision | null;
  onClose: () => void;
  onApprove?: (decisionId: string, note?: string) => Promise<DecisionActionSummary>;
  onReject?: (decisionId: string, note?: string) => Promise<DecisionActionSummary>;
}

type ModalPhase = 'idle' | 'approving' | 'rejecting' | 'success' | 'rejected' | 'error';

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
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

  // Reset state when decision changes
  useEffect(() => {
    if (open) {
      setPhase('idle');
      setErrorMessage(null);
      setSelectedOption(null);
      setNote('');
      setShowNotes(false);
      setCopied(false);
    }
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
    };
  }, [open, decision?.id]);

  const requestedAt = decision?.requestedAt ?? null;
  const meta = (decision?.metadata ?? {}) as Record<string, unknown>;

  const options = useMemo(() => {
    const raw = meta.options ?? meta.option ?? meta.actions ?? null;
    if (Array.isArray(raw)) {
      const parsed = raw
        .map((item) => {
          if (typeof item === 'string') return { label: item, action: item };
          if (!item || typeof item !== 'object') return null;
          const record = item as Record<string, unknown>;
          const label = typeof record.label === 'string' ? record.label : null;
          const action = typeof record.action === 'string' ? record.action : null;
          const value = label ?? action ?? null;
          if (!value) return null;
          return { label: label ?? value, action: action ?? value };
        })
        .filter(Boolean) as Array<{ label: string; action: string }>;
      return parsed;
    }
    return [];
  }, [meta]);

  const context = useMemo(() => {
    const value = (decision?.context ?? '').trim();
    if (value) return value;
    const fallback =
      (typeof meta.summary === 'string' ? meta.summary : null) ??
      (typeof meta.description === 'string' ? meta.description : null) ??
      '';
    return String(fallback ?? '').trim();
  }, [decision?.context, meta]);

  const urgencyColor = useMemo(() => {
    const mins = decision?.waitingMinutes ?? 0;
    if (mins >= 15) return colors.red;
    if (mins >= 5) return colors.amber;
    return colors.teal;
  }, [decision?.waitingMinutes]);

  const copyDetails = async () => {
    if (!decision) return;
    const payload = safeJson({ decision, metadata: meta });
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silently fail */
    }
  };

  const buildNote = useCallback(() => {
    const parts: string[] = [];
    if (selectedOption) parts.push(`Selected: ${selectedOption}`);
    if (note.trim()) parts.push(note.trim());
    return parts.length > 0 ? parts.join('\n') : undefined;
  }, [selectedOption, note]);

  const handleApprove = async () => {
    if (!decision || !onApprove || phase === 'approving' || phase === 'rejecting') return;
    setErrorMessage(null);
    setPhase('approving');
    try {
      const result = await onApprove(decision.id, buildNote());
      if (result.failed > 0) {
        setPhase('error');
        setErrorMessage(`Approval failed. Please try again.`);
      } else {
        setPhase('success');
        autoCloseTimer.current = setTimeout(() => onClose(), 800);
      }
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Approval failed.');
    }
  };

  const handleReject = async () => {
    if (!decision || !onReject || phase === 'approving' || phase === 'rejecting') return;
    setErrorMessage(null);
    setPhase('rejecting');
    try {
      const result = await onReject(decision.id, buildNote());
      if (result.failed > 0) {
        setPhase('error');
        setErrorMessage(`Rejection failed. Please try again.`);
      } else {
        setPhase('rejected');
        autoCloseTimer.current = setTimeout(() => onClose(), 800);
      }
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Rejection failed.');
    }
  };

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
  });

  if (!open || !decision) return null;

  const busy = phase === 'approving' || phase === 'rejecting';
  const resolved = phase === 'success' || phase === 'rejected';
  const status = (decision.status ?? 'pending').toLowerCase();
  const isPending = !status.includes('approved') && !status.includes('resolved') && !status.includes('rejected');

  // Success / rejected overlay
  if (resolved) {
    return (
      <Modal open={open} onClose={onClose} maxWidth="max-w-xl" fitContent>
        <div className="flex flex-col items-center justify-center px-8 py-12">
          <div
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
            style={{
              backgroundColor: phase === 'success' ? `${colors.lime}18` : `${colors.red}18`,
              border: `1.5px solid ${phase === 'success' ? `${colors.lime}40` : `${colors.red}40`}`,
            }}
          >
            {phase === 'success' ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={colors.lime} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={colors.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            )}
          </div>
          <p className="text-heading font-semibold text-white">
            {phase === 'success' ? 'Approved' : 'Rejected'}
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
                  {decision.agentName ? `${decision.agentName}` : 'System'}
                  {' \u00b7 '}
                  {decision.waitingMinutes}m waiting
                  {requestedAt ? ` \u00b7 ${formatRelativeTime(requestedAt)}` : ''}
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
                  const isActive = selectedOption === option.action;
                  return (
                    <button
                      key={`${option.label}:${option.action}`}
                      type="button"
                      onClick={() => setSelectedOption(isActive ? null : option.action)}
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
                      <span className={`text-body ${isActive ? 'font-medium text-white' : 'text-primary'}`}>
                        {option.label}
                      </span>
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
                </div>
              )}
            </div>
          )}

          {/* Comments thread (collapsed by default) */}
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
                  disabled={busy}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-body font-medium text-secondary transition-all hover:border-red-400/30 hover:bg-red-400/8 hover:text-red-300 disabled:opacity-40"
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
                {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter
              </span>
              <button
                type="button"
                onClick={handleApprove}
                disabled={!onApprove || busy}
                data-modal-autofocus="true"
                className="rounded-lg px-5 py-2 text-body font-semibold transition-all"
                style={{
                  backgroundColor: !onApprove || busy ? 'rgba(255,255,255,0.08)' : colors.lime,
                  color: !onApprove || busy ? 'rgba(255,255,255,0.4)' : '#000',
                  boxShadow: !onApprove || busy ? 'none' : `0 0 20px ${colors.lime}20`,
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
