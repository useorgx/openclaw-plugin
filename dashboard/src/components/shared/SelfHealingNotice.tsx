import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';

interface SelfHealingNoticeProps {
  title: string;
  detail?: string;
  /** When this flips to true, the notice auto-dismisses with a success animation */
  recovered?: boolean;
  /** Auto-dismiss after this many ms (default 30000) */
  timeoutMs?: number;
  onDismiss?: () => void;
}

export function SelfHealingNotice({
  title,
  detail,
  recovered = false,
  timeoutMs = 30000,
  onDismiss,
}: SelfHealingNoticeProps) {
  const [dismissed, setDismissed] = useState(false);
  const [showRecovered, setShowRecovered] = useState(false);

  useEffect(() => {
    if (recovered) {
      setShowRecovered(true);
      const t = setTimeout(() => {
        setDismissed(true);
        onDismiss?.();
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [recovered, onDismiss]);

  useEffect(() => {
    if (!recovered) {
      const t = setTimeout(() => {
        setDismissed(true);
        onDismiss?.();
      }, timeoutMs);
      return () => clearTimeout(t);
    }
  }, [recovered, timeoutMs, onDismiss]);

  if (dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className={showRecovered ? 'success-glow' : ''}
      >
        <div
          className="rounded-xl px-3.5 py-2.5"
          style={{
            backgroundColor: showRecovered
              ? 'rgba(10, 18, 16, 0.95)'
              : 'rgba(18, 16, 10, 0.95)',
            border: `1px solid ${showRecovered ? `${colors.lime}40` : `${colors.amber}35`}`,
          }}
        >
          <div className="flex items-center gap-2.5">
            {showRecovered ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.lime}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.amber}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-pulse"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            )}
            <div className="min-w-0 flex-1">
              <p
                className="text-caption font-medium"
                style={{ color: showRecovered ? colors.lime : colors.amber }}
              >
                {showRecovered ? 'Recovered' : title}
              </p>
              {!showRecovered && detail && (
                <p className="mt-0.5 text-micro text-secondary">{detail}</p>
              )}
            </div>
          </div>

          {/* Animated progress line — indeterminate */}
          {!showRecovered && (
            <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full origin-left rounded-full"
                style={{
                  backgroundColor: colors.amber,
                  opacity: 0.5,
                  animation: `selfHealProgress ${timeoutMs}ms linear forwards`,
                }}
              />
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
