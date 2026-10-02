import type { CSSProperties } from 'react';
import { OxAttentionLine } from '@useorgx/orgx-ui-kit/react';

interface ContextualStatusProps {
  running: number;
  blocked: number;
  decisionsCount: number;
  completedToday: number;
  onNeedsAttentionClick?: () => void;
  onDecisionsClick?: () => void;
  onBlockedClick?: () => void;
  onNewInitiative?: () => void;
  className?: string;
}

type AttentionTone = 'needs-you' | 'blocking' | 'calm';

/**
 * The one line that opens the dashboard: quiet when fine, loud only when it
 * needs you. Rendered with the OrgX kit's <ox-attention-line> so it reads the
 * same as the MCP widgets and the app: amber when decisions wait on you, red
 * when work is blocked, a calm teal line otherwise.
 */
function resolveState(props: ContextualStatusProps): {
  tone: AttentionTone;
  count: number;
  label: string;
  meta: string | null;
  action: { text: string; onClick: () => void } | null;
} {
  const {
    running,
    blocked,
    decisionsCount,
    completedToday,
    onNeedsAttentionClick,
    onDecisionsClick,
    onBlockedClick,
    onNewInitiative,
  } = props;
  const needsAttention = decisionsCount + blocked;
  const attentionHandler = onNeedsAttentionClick ?? onDecisionsClick ?? onBlockedClick;
  const runningMeta = running > 0 ? `${running} running` : null;

  if (needsAttention > 0) {
    // Short sentence, breakdown as meta, so the line never truncates the part that matters.
    const breakdown = [
      blocked > 0 ? `${blocked} blocked` : null,
      decisionsCount > 0 ? `${decisionsCount} decision${decisionsCount === 1 ? '' : 's'}` : null,
      runningMeta,
    ].filter(Boolean);
    return {
      tone: blocked > 0 ? 'blocking' : 'needs-you',
      count: needsAttention,
      label: `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`,
      meta: breakdown.join(' · ') || null,
      action: attentionHandler ? { text: 'Review', onClick: attentionHandler } : null,
    };
  }

  if (running === 0 && completedToday === 0) {
    return {
      tone: 'calm',
      count: 0,
      label: onNewInitiative ? 'All caught up.' : 'All caught up. Nothing running.',
      meta: null,
      action: onNewInitiative ? { text: 'Start something new', onClick: onNewInitiative } : null,
    };
  }

  if (running === 0) {
    return {
      tone: 'calm',
      count: 0,
      label: `${completedToday} done today · all caught up`,
      meta: null,
      action: null,
    };
  }

  return {
    tone: 'calm',
    count: 0,
    label: `${running} running · all systems go`,
    meta: null,
    action: null,
  };
}

export function ContextualStatus(props: ContextualStatusProps) {
  const { className } = props;
  const { tone, count, label, meta, action } = resolveState(props);
  // When there is something to review, the sentence itself is the control
  // (as before); otherwise it is plain text with an optional trailing action.
  const sentenceIsAction = tone !== 'calm' && action;

  return (
    <div className={`flex min-w-0 items-center whitespace-nowrap ${className ?? ''}`}>
      <OxAttentionLine
        className="min-w-0 flex-1"
        style={{ '--ox-attention-padding': '0' } as CSSProperties}
        tone={tone}
        count={count}
        label={label}
        meta={meta ? <span className="hidden 2xl:inline">{meta}</span> : undefined}
        action={
          action && !sentenceIsAction ? (
            <button
              type="button"
              onClick={action.onClick}
              className="ml-2 inline-flex min-h-[32px] items-center rounded-md px-2 text-caption font-semibold text-secondary transition-colors hover:bg-white/[0.06] hover:text-bright"
            >
              {action.text}
            </button>
          ) : undefined
        }
      >
        {sentenceIsAction ? (
          <button
            type="button"
            onClick={action.onClick}
            title={meta ?? undefined}
            className="max-w-full truncate font-[inherit] text-inherit underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-80"
          >
            {label}
          </button>
        ) : null}
      </OxAttentionLine>
    </div>
  );
}
