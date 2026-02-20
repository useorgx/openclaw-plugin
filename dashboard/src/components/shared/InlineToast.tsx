import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';

type ToastTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface InlineToastProps {
  open: boolean;
  tone?: ToastTone;
  title: string;
  message?: string | null;
  className?: string;
  primaryAction?: ToastAction | null;
  secondaryAction?: ToastAction | null;
  onDismiss?: (() => void) | null;
  autoDismissMs?: number | null;
}

function toneClasses(tone: ToastTone): string {
  if (tone === 'success') return 'border-emerald-400/30 bg-emerald-500/14 text-emerald-100';
  if (tone === 'warning') return 'border-amber-300/30 bg-amber-400/14 text-amber-100';
  if (tone === 'error') return 'border-red-400/32 bg-red-500/16 text-red-100';
  if (tone === 'info') return 'border-cyan-300/28 bg-cyan-400/12 text-cyan-100';
  return 'border-strong bg-[#0B0F16]/95 text-primary';
}

export function InlineToast({
  open,
  tone = 'neutral',
  title,
  message = null,
  className,
  primaryAction = null,
  secondaryAction = null,
  onDismiss = null,
  autoDismissMs = null,
}: InlineToastProps) {
  useEffect(() => {
    if (!open || !onDismiss || !autoDismissMs) return;
    const timeout = window.setTimeout(() => onDismiss(), autoDismissMs);
    return () => window.clearTimeout(timeout);
  }, [autoDismissMs, onDismiss, open, title, message]);

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.985 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className={className ?? ''}
        >
          <div
            className={`min-w-[220px] max-w-[420px] rounded-xl border px-3 py-2 shadow-[0_16px_36px_rgba(0,0,0,0.42)] backdrop-blur ${toneClasses(tone)}`}
          >
            <div className="flex items-start gap-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-caption font-semibold">{title}</p>
                {message ? (
                  <p className="mt-0.5 text-caption opacity-85">{message}</p>
                ) : null}
              </div>
              {onDismiss ? (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-current/70 transition-colors hover:bg-white/[0.08] hover:text-current"
                  aria-label="Dismiss toast"
                  title="Dismiss"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              ) : null}
            </div>
            {(primaryAction || secondaryAction) ? (
              <div className="mt-2 flex items-center gap-1.5">
                {secondaryAction ? (
                  <button
                    type="button"
                    onClick={secondaryAction.onClick}
                    className="h-7 rounded-md border border-strong bg-white/[0.06] px-2.5 text-micro font-semibold text-current transition-colors hover:bg-white/[0.12]"
                  >
                    {secondaryAction.label}
                  </button>
                ) : null}
                {primaryAction ? (
                  <button
                    type="button"
                    onClick={primaryAction.onClick}
                    className="h-7 rounded-md border border-white/25 bg-white/[0.14] px-2.5 text-micro font-semibold text-current transition-colors hover:bg-white/[0.2]"
                  >
                    {primaryAction.label}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
