import { AnimatePresence, motion } from 'framer-motion';
import { ExplainerPanel } from '@/components/onboarding/ExplainerPanel';
import { ManualKeyPanel } from '@/components/onboarding/ManualKeyPanel';
import type { OnboardingState, OnboardingStatus } from '@/types';

interface OnboardingGateProps {
  state: OnboardingState;
  isLoading: boolean;
  isStarting: boolean;
  isSubmittingManual: boolean;
  onRefresh: () => Promise<unknown>;
  onStartPairing: () => Promise<void>;
  onSubmitManualKey: (apiKey: string, userId?: string) => Promise<unknown>;
  onUseManualKey: () => void;
  onSkip: () => void;
}

/* ── Status helpers ────────────────────────────────────────────────── */

function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting secure session...';
    case 'awaiting_browser_auth':
      return 'Waiting for browser approval...';
    case 'pairing':
      return 'Confirming connection...';
    case 'manual_key':
      return 'Manual key entry';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Connection issue';
    default:
      return 'Ready to connect';
  }
}

type DotState = 'idle' | 'active' | 'error';

function dotState(status: OnboardingStatus): DotState {
  if (status === 'awaiting_browser_auth' || status === 'pairing' || status === 'starting') return 'active';
  if (status === 'error') return 'error';
  if (status === 'connected') return 'active';
  return 'idle';
}

const dotStyle: Record<DotState, string> = {
  idle: 'bg-white/40',
  active: 'bg-[#BFFF00]',
  error: 'bg-red-400',
};

/* ── Animation ─────────────────────────────────────────────────────── */

const pageTransition = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.985 },
  transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] },
};

/* ── Component ─────────────────────────────────────────────────────── */

export function OnboardingGate({
  state,
  isLoading,
  isStarting,
  isSubmittingManual,
  onRefresh,
  onStartPairing,
  onSubmitManualKey,
  onUseManualKey,
  onSkip,
}: OnboardingGateProps) {
  const showManual = state.status === 'manual_key';
  const showPairingState = state.status === 'awaiting_browser_auth' || state.status === 'pairing';
  const dot = dotState(state.status);
  const isPulsing = dot === 'active' && state.status !== 'connected';

  return (
    <div
      className="relative flex min-h-screen items-center justify-center px-4 py-10 sm:py-16"
      style={{ backgroundColor: '#02040A' }}
    >
      {/* Background atmosphere */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ambient-orb orb-lime" style={{ width: 500, height: 500, top: -200, left: -160 }} />
        <div className="ambient-orb orb-teal" style={{ width: 560, height: 560, bottom: -240, right: -170 }} />
        <div className="ambient-orb orb-iris" style={{ width: 340, height: 340, bottom: '20%', left: '50%', animationDelay: '3s' }} />
        <div className="grain-overlay absolute inset-0" />
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.45 }}
        className="relative z-10 w-full max-w-lg"
      >
        {isLoading ? (
          /* ── Loading skeleton ─────────────────────────────────── */
          <div className="glass-panel rounded-2xl p-6 sm:p-8">
            <div className="shimmer-skeleton h-7 w-28 rounded-lg" />
            <div className="shimmer-skeleton mt-5 h-8 w-3/4 rounded-lg" />
            <div className="shimmer-skeleton mt-3 h-4 w-2/3 rounded-lg" />
            <div className="mt-7 grid grid-cols-3 gap-2.5">
              <div className="shimmer-skeleton h-24 rounded-xl" />
              <div className="shimmer-skeleton h-24 rounded-xl" />
              <div className="shimmer-skeleton h-24 rounded-xl" />
            </div>
            <div className="shimmer-skeleton mt-7 h-10 w-36 rounded-full" />
          </div>
        ) : (
          /* ── Content ─────────────────────────────────────────── */
          <AnimatePresence mode="wait">
            {!showManual ? (
              <motion.div key="explainer" {...pageTransition}>
                <ExplainerPanel
                  state={state}
                  isStarting={isStarting}
                  onConnect={() => { void onStartPairing(); }}
                  onUseManualKey={onUseManualKey}
                  onContinueWithoutOrgX={onSkip}
                />
              </motion.div>
            ) : (
              <motion.div key="manual" {...pageTransition}>
                <ManualKeyPanel
                  isSubmitting={isSubmittingManual}
                  onSubmit={onSubmitManualKey}
                  onBack={() => { void onRefresh(); }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {/* ── Floating status pill ─────────────────────────────── */}
        {!isLoading && (showPairingState || state.status === 'connected') && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ delay: 0.15, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3"
          >
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2 w-2">
                {isPulsing && (
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotStyle[dot]} opacity-40`} />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${dotStyle[dot]}`} />
              </span>
              <span className="text-[13px] text-white/60">{statusLabel(state.status)}</span>
              {state.workspaceName && (
                <span className="chip">{state.workspaceName}</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {state.expiresAt && (
                <span className="text-[11px] text-white/30">
                  {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {state.connectUrl && showPairingState && (
                <a
                  href={state.connectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-[#BFFF00]/25 bg-[#BFFF00]/[0.05] px-3 py-1 text-[11px] font-medium text-[#D8FFA1] transition hover:bg-[#BFFF00]/[0.1]"
                >
                  Approve in browser
                </a>
              )}
              <button
                type="button"
                onClick={() => { void onRefresh(); }}
                className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-white/40 transition hover:bg-white/[0.04] hover:text-white/60"
              >
                Refresh
              </button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
