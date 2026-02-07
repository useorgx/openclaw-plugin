import { ExplainerPanel } from '@/components/onboarding/ExplainerPanel';
import { ManualKeyPanel } from '@/components/onboarding/ManualKeyPanel';
import type { OnboardingState } from '@/types';

interface OnboardingGateProps {
  state: OnboardingState;
  isLoading: boolean;
  isStarting: boolean;
  isSubmittingManual: boolean;
  onRefresh: () => Promise<unknown>;
  onStartPairing: () => Promise<void>;
  onSubmitManualKey: (apiKey: string, userId?: string) => Promise<unknown>;
  onUseManualKey: () => void;
}

function statusLabel(state: OnboardingState): string {
  switch (state.status) {
    case 'starting':
      return 'Starting secure pairing session...';
    case 'awaiting_browser_auth':
      return 'Open the browser tab and approve access.';
    case 'pairing':
      return 'Waiting for confirmation from useorgx.com...';
    case 'manual_key':
      return 'Use manual key fallback';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Connection issue';
    default:
      return 'Connect OrgX to continue';
  }
}

export function OnboardingGate({
  state,
  isLoading,
  isStarting,
  isSubmittingManual,
  onRefresh,
  onStartPairing,
  onSubmitManualKey,
  onUseManualKey,
}: OnboardingGateProps) {
  const showManual = state.status === 'manual_key';
  const showPairingState = state.status === 'awaiting_browser_auth' || state.status === 'pairing';

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-8" style={{ backgroundColor: '#05070f' }}>
      <div className="pointer-events-none absolute inset-0">
        <div className="ambient-orb orb-lime" style={{ width: 440, height: 440, top: -180, left: -140 }} />
        <div className="ambient-orb orb-teal" style={{ width: 520, height: 520, bottom: -220, right: -150 }} />
        <div className="grain-overlay absolute inset-0" />
      </div>

      <div className="relative z-10 w-full max-w-3xl space-y-4">
        {isLoading ? (
          <div className="rounded-2xl border border-white/[0.12] bg-white/[0.04] p-6 text-sm text-white/70">
            Loading onboarding state...
          </div>
        ) : null}

        {!showManual ? (
          <ExplainerPanel
            state={state}
            isStarting={isStarting}
            onConnect={() => {
              void onStartPairing();
            }}
            onUseManualKey={onUseManualKey}
          />
        ) : (
          <ManualKeyPanel
            isSubmitting={isSubmittingManual}
            onSubmit={onSubmitManualKey}
            onBack={() => {
              void onRefresh();
            }}
          />
        )}

        <section className="rounded-2xl border border-white/[0.12] bg-white/[0.04] p-4 text-sm text-white/75">
          <p className="font-medium text-white">{statusLabel(state)}</p>
          {state.workspaceName ? (
            <p className="mt-1 text-xs text-[#BFFF00]/80">Workspace: {state.workspaceName}</p>
          ) : null}
          {state.expiresAt ? (
            <p className="mt-1 text-xs text-white/55">
              Pairing expires: {new Date(state.expiresAt).toLocaleTimeString()}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            {state.connectUrl && showPairingState ? (
              <a
                href={state.connectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-[#BFFF00]/50 bg-[#BFFF00]/10 px-3 py-1.5 text-xs text-[#D8FFA1] transition hover:bg-[#BFFF00]/20"
              >
                Open connect page
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void onRefresh();
              }}
              className="rounded-full border border-white/[0.2] bg-white/[0.02] px-3 py-1.5 text-xs text-white/75 transition hover:bg-white/[0.08]"
            >
              Refresh status
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
