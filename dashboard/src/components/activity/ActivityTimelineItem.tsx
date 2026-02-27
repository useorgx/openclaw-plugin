import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { MarkdownText } from '@/components/shared/MarkdownText';

const itemVariants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
};

export interface ArtifactSnippet {
  label: string;
  preview: string;
  hasRegisteredId: boolean;
}

interface ActivityTimelineItemProps {
  renderKey: string;
  displayTitle: string;
  headline: string;
  contextLabel: string;
  detailText: string | null;
  displayAgentName: string;
  railColor: string;
  userStateLabel: string;
  userStateWhy: string;
  relativeTime: string;
  timeLabel: string;
  isRecent: boolean;
  enableMotion: boolean;
  onOpen: () => void;
  ariaLabel: string;
  artifactSnippet?: ArtifactSnippet | null;
}

export function ActivityTimelineItem({
  renderKey,
  displayTitle,
  headline,
  contextLabel,
  detailText,
  displayAgentName,
  railColor,
  userStateLabel,
  userStateWhy,
  relativeTime,
  timeLabel,
  isRecent,
  enableMotion,
  onOpen,
  ariaLabel,
  artifactSnippet,
}: ActivityTimelineItemProps) {
  const commonClassName =
    "group w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-strong hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/45 cv-auto";

  const content = (
    <div className="flex items-start gap-3">
      <div className="mt-0.5">
        <AgentAvatar
          name={displayAgentName}
          hint={displayAgentName}
          size="xs"
        />
      </div>
      <div className="relative min-w-0 flex-1 pl-3">
        <span
          className={cn('absolute inset-y-0 left-0 w-[2px] rounded-full', isRecent && 'pulse-soft')}
          style={{
            backgroundColor: railColor,
            boxShadow: `0 0 14px ${railColor}66`,
          }}
        />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-caption text-secondary" title={contextLabel}>
              {contextLabel}
            </p>
            <p className="mt-0.5 line-clamp-1 break-words text-body font-semibold leading-snug text-bright">
              {headline || displayTitle}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-caption text-secondary">{timeLabel}</span>
            <span className="text-micro text-muted">{relativeTime}</span>
          </div>
        </div>

        {artifactSnippet ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/[0.06] px-2.5 py-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-caption text-cyan-200/90">
              <span className="font-semibold">{artifactSnippet.label}</span>
              {artifactSnippet.preview && (
                <span className="ml-1.5 text-cyan-200/60">{artifactSnippet.preview}</span>
              )}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#67e8f9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-50">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </div>
        ) : detailText ? (
          <div className="mt-1.5 line-clamp-2 text-caption leading-relaxed text-secondary">
            <MarkdownText mode="inline" text={detailText} />
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro">
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold tracking-[0.01em]"
            style={{
              borderColor: `${railColor}55`,
              backgroundColor: `${railColor}1A`,
              color: railColor,
            }}
            title={userStateWhy}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: railColor }} />
            {userStateLabel}
          </span>
          <span
            className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary"
            title={displayAgentName}
          >
            <span className="truncate">{displayAgentName}</span>
          </span>
        </div>
      </div>
    </div>
  );

  if (!enableMotion) {
    return (
      <button
        type="button"
        key={renderKey}
        onClick={onOpen}
        className={cn(
          commonClassName,
          "transform-gpu transition-[transform,background-color,border-color,color] hover:-translate-y-[1px] active:scale-[0.995]"
        )}
        aria-label={ariaLabel}
      >
        {content}
      </button>
    );
  }

  return (
    <motion.button
      type="button"
      key={renderKey}
      variants={itemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      whileHover={{ y: -1.5 }}
      whileTap={{ scale: 0.995 }}
      onClick={onOpen}
      className={commonClassName}
      aria-label={ariaLabel}
    >
      {content}
    </motion.button>
  );
}
