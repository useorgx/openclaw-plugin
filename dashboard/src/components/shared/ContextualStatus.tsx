import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';

interface ContextualStatusProps {
  running: number;
  blocked: number;
  decisionsCount: number;
  completedToday: number;
  onDecisionsClick?: () => void;
  onBlockedClick?: () => void;
  onNewInitiative?: () => void;
}

function resolveState(props: ContextualStatusProps): {
  key: string;
  segments: Array<{ text: string; color?: string; clickable?: boolean; onClick?: () => void }>;
} {
  const { running, blocked, decisionsCount, completedToday, onDecisionsClick, onBlockedClick, onNewInitiative } = props;
  const needsAttention = decisionsCount + blocked;

  if (running === 0 && needsAttention === 0 && completedToday === 0) {
    return {
      key: 'idle-empty',
      segments: [
        { text: 'All caught up. ' },
        onNewInitiative
          ? { text: 'Start something new?', color: colors.lime, clickable: true, onClick: onNewInitiative }
          : { text: 'Nothing running.' },
      ],
    };
  }

  if (running === 0 && needsAttention === 0) {
    return {
      key: 'idle-done',
      segments: [
        { text: `${completedToday} done today`, color: colors.teal },
        { text: ' · all caught up' },
      ],
    };
  }

  if (blocked > 0 && decisionsCount > 0) {
    return {
      key: `blocked-decisions-${blocked}-${decisionsCount}-${running}`,
      segments: [
        ...(running > 0 ? [{ text: `${running} running · ` }] : []),
        { text: `${blocked} blocked`, color: colors.red, clickable: true, onClick: onBlockedClick },
        { text: ' · ' },
        { text: `${decisionsCount} need your input`, color: colors.amber, clickable: true, onClick: onDecisionsClick },
      ],
    };
  }

  if (blocked > 0) {
    return {
      key: `blocked-${blocked}-${running}`,
      segments: [
        { text: `${blocked} blocked`, color: colors.red, clickable: true, onClick: onBlockedClick },
        ...(running > 0 ? [{ text: ` · ${running} running` }] : []),
      ],
    };
  }

  if (decisionsCount > 0) {
    return {
      key: `decisions-${decisionsCount}-${running}`,
      segments: [
        ...(running > 0 ? [{ text: `${running} running`, color: colors.lime }, { text: ' · ' }] : []),
        { text: `${decisionsCount} need your input`, color: colors.amber, clickable: true, onClick: onDecisionsClick },
      ],
    };
  }

  return {
    key: `running-${running}`,
    segments: [
      { text: `${running} running`, color: colors.lime },
      { text: ' · all systems go' },
    ],
  };
}

export function ContextualStatus(props: ContextualStatusProps) {
  const { key, segments } = resolveState(props);

  return (
    <div className="flex items-center gap-1.5 text-body">
      <AnimatePresence mode="wait">
        <motion.span
          key={key}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="inline-flex flex-wrap items-baseline gap-0"
        >
          {segments.map((seg, i) =>
            seg.clickable && seg.onClick ? (
              <button
                key={i}
                onClick={seg.onClick}
                className="font-semibold transition-opacity hover:opacity-80"
                style={{ color: seg.color }}
              >
                {seg.text}
              </button>
            ) : (
              <span
                key={i}
                className={seg.color ? 'font-semibold' : 'text-secondary'}
                style={seg.color ? { color: seg.color } : undefined}
              >
                {seg.text}
              </span>
            )
          )}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
