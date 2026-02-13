import { colors } from '@/lib/tokens';
import type { Decision } from '@/types';

interface DecisionBannerProps {
  decisions: Decision[];
  onDecide: (decision: Decision) => void;
}

export function DecisionBanner({ decisions, onDecide }: DecisionBannerProps) {
  if (!decisions || decisions.length === 0) return null;

  const decision = decisions[0];
  const remaining = decisions.length - 1;
  const accentColor = decision.waitingMinutes >= 60 ? colors.red : colors.amber;

  return (
    <div
      className="flex-shrink-0 flex items-center justify-between px-4 py-2 mx-4 mt-3 rounded-xl"
      style={{
        backgroundColor: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <div className="flex items-center gap-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="M12 8v4" /><path d="M12 16h.01" />
        </svg>
        <div>
          <span className="text-xs font-medium text-white">
            {decision.title}
          </span>
          <span className="text-micro text-muted ml-2">
            {decision.agent} · {decision.waitingMinutes}m
          </span>
        </div>
        {remaining > 0 && (
          <span
            className="px-1.5 py-0.5 rounded text-micro font-bold"
            style={{ color: accentColor, backgroundColor: `${accentColor}15` }}
          >
            +{remaining}
          </span>
        )}
      </div>
      <button
        onClick={() => onDecide(decision)}
        className="px-3 py-1 rounded-lg text-micro font-bold"
        style={{ backgroundColor: accentColor, color: '#000' }}
      >
        REVIEW
      </button>
    </div>
  );
}
