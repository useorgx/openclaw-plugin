import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { listItemVariants, motion as motionTokens } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';

interface ErrorStateAction {
  label: string;
  onClick: () => void;
}

interface ErrorStateProps {
  error: string | Error;
  onRetry?: () => void;
  secondaryAction?: ErrorStateAction;
  className?: string;
}

export function ErrorState({
  error,
  onRetry,
  secondaryAction,
  className,
}: ErrorStateProps) {
  const [showDetails, setShowDetails] = useState(false);
  const rawMessage = error instanceof Error ? error.message : error;
  const humanized = humanizeWarning(rawMessage);
  const hasDetails = humanized !== rawMessage;

  return (
    <motion.div
      className={cn('flex flex-col items-center justify-center py-12 px-6 text-center max-w-md mx-auto', className)}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
    >
      <motion.div
        className="flex h-12 w-12 items-center justify-center rounded-xl border border-red-400/30 bg-red-500/[0.10]"
        variants={listItemVariants}
        custom={0}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" className="text-red-300">
          <path
            d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
          <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </motion.div>
      <motion.h4
        className="mt-5 text-heading font-semibold text-white"
        variants={listItemVariants}
        custom={1}
      >
        Something went wrong
      </motion.h4>
      <motion.p
        className="mt-2 text-body text-secondary leading-relaxed"
        variants={listItemVariants}
        custom={2}
      >
        {humanized}
      </motion.p>

      <motion.div
        className="mt-5 flex items-center gap-2"
        variants={listItemVariants}
        custom={3}
      >
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="control-pill px-4 text-[12px] font-medium"
            style={{
              borderColor: 'rgba(191, 255, 0, 0.24)',
              background: 'rgba(191, 255, 0, 0.09)',
              color: '#d8ffa1',
            }}
          >
            Try again
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

      {hasDetails && (
        <motion.div className="mt-4 w-full" variants={listItemVariants} custom={4}>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-micro text-muted hover:text-secondary transition-colors"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          <AnimatePresence>
            {showDetails && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: motionTokens.durationEntrance / 1000 }}
                className="overflow-hidden"
              >
                <pre className="mt-2 rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-left text-micro text-muted font-mono leading-relaxed whitespace-pre-wrap break-all">
                  {rawMessage}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.div>
  );
}
