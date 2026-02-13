import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { Modal } from '@/components/shared/Modal';
import type { Decision } from '@/types';

interface DecisionModalProps {
  decision: Decision | null;
  onClose: () => void;
  onAction: (decisionId: string, action: string) => void;
}

export function DecisionModal({
  decision,
  onClose,
  onAction,
}: DecisionModalProps) {
  if (!decision) return null;

  return (
    <Modal open={!!decision} onClose={onClose} maxWidth="max-w-md" fitContent>
      <div className="border-b border-subtle px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-400/10"
            style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              <path d="M12 8v4" /><path d="M12 16h.01" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-medium text-white">
              {decision.title}
            </h3>
            <span className="text-caption text-secondary">
              {decision.agent} · Waiting {decision.waitingMinutes}m
            </span>
          </div>
        </div>
      </div>

      <div className="max-h-[52vh] overflow-y-auto px-5 py-4 sm:px-6">
        <p className="text-body leading-relaxed text-primary">
          {decision.context}
        </p>
      </div>

      <div className="flex justify-end gap-2.5 border-t border-subtle px-5 py-3.5 sm:px-6">
        <button
          onClick={onClose}
          className="rounded-lg border border-strong bg-white/[0.03] px-3.5 py-2 text-body font-medium text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
        >
          Later
        </button>
        {decision.options?.map((opt) => (
          <button
            key={opt.action}
            onClick={() => {
              onAction(decision.id, opt.action);
              onClose();
            }}
            className={cn(
              'rounded-lg px-3.5 py-2 text-body font-medium transition-colors',
              opt.action === 'approve'
                ? 'text-black'
                : 'border border-strong bg-white/[0.06] text-white hover:bg-white/[0.1]'
            )}
            style={
              opt.action === 'approve'
                ? { backgroundColor: colors.lime }
                : undefined
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
