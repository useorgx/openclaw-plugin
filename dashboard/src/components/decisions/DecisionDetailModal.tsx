import { useMemo, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Markdown } from '@/components/shared/Markdown';
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
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <EntityIcon type="decision" size={14} />
              <h2 className="truncate text-[14px] font-semibold text-white">
                {decision.title || 'Decision'}
              </h2>
              <span
                className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                style={{
                  borderColor: statusTone.border,
                  backgroundColor: statusTone.bg,
                  color: statusTone.text,
                }}
              >
                {status}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-white/45">
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
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
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
              <p className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/40">
                Context
              </p>
              <Markdown>{context}</Markdown>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-[12px] text-white/55">
              No context provided for this decision.
            </div>
          )}

          {options.length > 0 && (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
              <p className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/40">
                Options
              </p>
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <span
                    key={`${option.label}:${option.action}`}
                    className="inline-flex items-center rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1 text-[11px] text-white/70"
                    title={option.action}
                  >
                    {option.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/40">
              Actions
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={approve}
                disabled={!onApprove || busy}
                data-modal-autofocus="true"
                className="rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors"
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
                className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                Copy JSON
              </button>
              {notice && (
                <span className="text-[11px] text-white/55">{notice}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

