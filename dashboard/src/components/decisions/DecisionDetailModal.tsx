import { useMemo, useState } from 'react';
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
  onApprove?: (decisionId: string) => Promise<DecisionActionSummary>;
}

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
}: DecisionDetailModalProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);

  const requestedAt = decision?.requestedAt ?? null;
  const updatedAt = decision?.updatedAt ?? null;
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

  const copyDetails = async () => {
    if (!decision) return;
    const payload = safeJson({ decision, metadata: meta });
    if (!payload) {
      setNotice('Unable to copy details.');
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setNotice('Copied decision JSON.');
    } catch {
      setNotice('Copy failed.');
    }
  };

  const approve = async () => {
    if (!decision || !onApprove || busy) return;
    setNotice(null);
    setBusy(true);
    try {
      const result = await onApprove(decision.id);
      if (result.failed > 0) {
        setNotice(`Approval failed for ${result.failed} item${result.failed === 1 ? '' : 's'}.`);
      } else {
        setNotice('Decision approved.');
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Decision approval failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!open || !decision) return null;

  const status = (decision.status ?? 'pending').toLowerCase();
  const statusTone =
    status.includes('approved') || status.includes('resolved')
      ? { border: `${colors.teal}40`, bg: `${colors.teal}14`, text: '#8ff7ec' }
      : status.includes('rejected')
        ? { border: `${colors.red}45`, bg: `${colors.red}12`, text: '#fecaca' }
        : { border: `${colors.amber}45`, bg: `${colors.amber}12`, text: '#ffe3a1' };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-3 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <EntityIcon type="decision" size={14} />
              <h2 className="truncate text-heading font-semibold text-white">
                {decision.title || 'Decision'}
              </h2>
              <span
                className="rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.12em]"
                style={{
                  borderColor: statusTone.border,
                  backgroundColor: statusTone.bg,
                  color: statusTone.text,
                }}
              >
                {status}
              </span>
            </div>
            <p className="mt-0.5 text-body text-secondary">
              {decision.agentName ? `${decision.agentName} · ` : ''}
              waiting {decision.waitingMinutes}m
              {requestedAt ? ` · requested ${formatRelativeTime(requestedAt)}` : ''}
              {updatedAt ? ` · updated ${formatRelativeTime(updatedAt)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close decision detail"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-strong bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
          {context ? (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
              <p className="mb-2 text-micro uppercase tracking-[0.12em] text-muted">
                Context
              </p>
              <MarkdownText text={context} mode="block" />
            </div>
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-body text-secondary">
              No context provided for this decision.
            </div>
          )}

          {options.length > 0 && (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
              <p className="mb-2 text-micro uppercase tracking-[0.12em] text-muted">
                Options
              </p>
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <span
                    key={`${option.label}:${option.action}`}
                    className="inline-flex items-center rounded-full border border-strong bg-white/[0.03] px-3 py-1 text-caption text-primary"
                    title={option.action}
                  >
                    {option.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
            <p className="mb-2 text-micro uppercase tracking-[0.12em] text-muted">
              Actions
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={approve}
                disabled={!onApprove || busy}
                data-modal-autofocus="true"
                className="rounded-lg px-3 py-1.5 text-caption font-semibold transition-colors"
                style={{
                  backgroundColor: !onApprove || busy ? 'rgba(255,255,255,0.08)' : colors.lime,
                  color: !onApprove || busy ? 'rgba(255,255,255,0.45)' : '#000',
                }}
              >
                {busy ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={copyDetails}
                className="rounded-lg border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-medium text-primary transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                Copy JSON
              </button>
              {notice && (
                <span className="text-caption text-secondary">{notice}</span>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-micro font-semibold uppercase tracking-[0.14em] text-muted">
                  Notes
                </p>
                <p className="text-caption text-muted">
                  Commentary thread for humans and agents on this decision.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNotes((prev) => !prev)}
                className="inline-flex items-center justify-center rounded-full border border-strong bg-white/[0.05] px-3 py-1.5 text-caption font-semibold tracking-wide text-primary transition-colors hover:bg-white/[0.09]"
              >
                {showNotes ? 'Hide' : 'Show'}
              </button>
            </div>
            {showNotes ? (
              <div className="mt-3 border-t border-subtle pt-3">
                <EntityCommentsPanel entityType="decision" entityId={decision.id} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
