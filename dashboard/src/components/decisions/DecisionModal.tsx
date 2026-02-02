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
    <Modal open={!!decision} onClose={onClose} maxWidth="max-w-md">
      <div className="px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
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
            <span className="text-[11px] text-white/40">
              {decision.agent} · Waiting {decision.waitingMinutes}m
            </span>
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        <p className="text-[13px] text-white/60 leading-relaxed">
          {decision.context}
        </p>
      </div>

      <div className="px-6 py-4 flex justify-end gap-3 border-t border-white/[0.06]">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-[12px] font-medium text-white/50 hover:text-white hover:bg-white/[0.04] transition-colors"
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
              'px-4 py-2 rounded-lg text-[12px] font-medium transition-colors',
              opt.action === 'approve'
                ? 'text-black'
                : 'bg-white/[0.06] text-white hover:bg-white/[0.1]'
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
