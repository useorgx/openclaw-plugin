import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { listItemVariants } from '@/lib/tokens';

type IconVariant = 'inbox' | 'search' | 'activity' | 'agents' | 'initiative' | 'queue' | 'error';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon?: IconVariant;
  headline: string;
  description: string;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
}

const iconPaths: Record<IconVariant, React.ReactNode> = {
  inbox: (
    <path d="M22 12h-6l-2 3H10l-2-3H2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  activity: (
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  agents: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </>
  ),
  initiative: (
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  queue: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  error: (
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

export function EmptyState({
  icon = 'inbox',
  headline,
  description,
  primaryAction,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <motion.div
      className={cn('flex flex-col items-center justify-center py-12 px-6 text-center max-w-md mx-auto', className)}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
    >
      <motion.div
        className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04]"
        variants={listItemVariants}
        custom={0}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" className="text-secondary">
          {iconPaths[icon]}
        </svg>
      </motion.div>
      <motion.h4
        className="mt-5 text-heading font-semibold text-white"
        variants={listItemVariants}
        custom={1}
      >
        {headline}
      </motion.h4>
      <motion.p
        className="mt-2 text-body text-secondary leading-relaxed"
        variants={listItemVariants}
        custom={2}
      >
        {description}
      </motion.p>
      {(primaryAction || secondaryAction) && (
        <motion.div
          className="mt-5 flex items-center gap-2"
          variants={listItemVariants}
          custom={3}
        >
          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              className="control-pill px-4 text-[12px] font-medium"
              style={{
                borderColor: 'rgba(191, 255, 0, 0.24)',
                background: 'rgba(191, 255, 0, 0.09)',
                color: '#d8ffa1',
              }}
            >
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="control-pill px-4 text-[12px] font-medium"
            >
              {secondaryAction.label}
            </button>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
