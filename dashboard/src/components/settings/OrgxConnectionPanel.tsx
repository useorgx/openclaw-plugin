import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { OnboardingState, OnboardingStatus } from '@/types';
import { ManualKeyPanel } from '@/components/onboarding/ManualKeyPanel';

function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting secure session...';
    case 'awaiting_browser_auth':
      return 'Waiting for browser approval...';
    case 'pairing':
      return 'Confirming connection...';
    case 'manual_key':
      return 'Manual API key';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Connection issue';
    default:
      return 'Ready to connect';
  }
}

function keySourceLabel(source: OnboardingState['keySource']): string {
  switch (source) {
    case 'config':
      return 'Plugin config';
    case 'environment':
      return 'Env key';
    case 'persisted':
      return 'Saved key';
    case 'openclaw-config-file':
      return 'OpenClaw key';
    case 'legacy-dev':
      return 'Legacy key';
    default:
      return 'No key';
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

export function OrgxConnectionPanel({
  state,
  isStarting,
  isSubmittingManual,
  onRefresh,
  onStartPairing,
  onSubmitManualKey,
  onBackToPairing,
  onUseManualKey,
  onDisconnect,
}: {
  state: OnboardingState;
  isStarting: boolean;
  isSubmittingManual: boolean;
  onRefresh: () => Promise<unknown>;
  onStartPairing: () => Promise<void>;
  onSubmitManualKey: (apiKey: string) => Promise<unknown>;
  onBackToPairing: () => void;
  onUseManualKey: () => void;
  onDisconnect: () => Promise<unknown>;
}) {
  const settingsUrl = 'https://www.useorgx.com/settings#security';
  const showManual = state.status === 'manual_key';
  const showPairingState = state.status === 'awaiting_browser_auth' || state.status === 'pairing';
  const dot = dotState(state.status);
  const isPulsing = dot === 'active' && state.status !== 'connected';
  const hasError = Boolean(state.lastError);

  const connectionSummary = useMemo(() => {
    if (state.status === 'connected' && state.connectionVerified) return 'Live sync active.';
    if (showPairingState) return 'Approve pairing in your browser to complete the connection.';
    if (state.status === 'starting') return 'Starting a secure pairing session.';
    if (state.status === 'error') return 'Trouble reaching OrgX. Reconnect or try a manual key.';
    if (state.hasApiKey) return 'API key detected. Verify connection to enable live features.';
    return 'Connect OrgX to sync initiatives, tasks, activity, and decisions.';
  }, [showPairingState, state.connectionVerified, state.hasApiKey, state.status]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold text-white">OrgX connection</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-white/55">
          {connectionSummary}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="chip inline-flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {isPulsing && (
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotStyle[dot]} opacity-40`} />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${dotStyle[dot]}`} />
            </span>
            <span className="text-white/80">{statusLabel(state.status)}</span>
          </span>
          {state.workspaceName && <span className="chip">{state.workspaceName}</span>}
          {state.keySource && state.keySource !== 'none' && (
            <span className="chip">{keySourceLabel(state.keySource)}</span>
          )}
          {state.hasApiKey && !state.connectionVerified && (
            <span className="chip text-amber-100/90">key present, not verified</span>
          )}
        </div>
      </div>

      {hasError && (
        <div className="mb-4 rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-[12px] text-rose-100">
          {state.lastError}
        </div>
      )}

      {showManual ? (
        <ManualKeyPanel
          isSubmitting={isSubmittingManual}
          onSubmit={onSubmitManualKey}
          onBack={onBackToPairing}
        />
      ) : (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { void onStartPairing(); }}
              disabled={isStarting}
              data-modal-autofocus="true"
              className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-4 py-2 text-[12px] font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStarting ? 'Connecting...' : 'Connect in browser'}
            </button>
            <button
              type="button"
              onClick={onUseManualKey}
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/[0.06]"
            >
              Use API key
            </button>
            {state.hasApiKey && (
              <button
                type="button"
                onClick={() => { void onDisconnect(); }}
                className="rounded-full border border-rose-300/25 bg-rose-400/10 px-4 py-2 text-[12px] font-semibold text-rose-100/90 transition-colors hover:bg-rose-400/15"
              >
                Disconnect
              </button>
            )}
            <button
              type="button"
              onClick={() => { void onRefresh(); }}
              className={cn(
                'rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/[0.06]',
                isStarting && 'opacity-60'
              )}
            >
              Refresh status
            </button>
            <a
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/[0.06]"
              title="Generate/revoke API keys at useorgx.com"
            >
              Open API keys
            </a>
          </div>

          {state.connectUrl && (showPairingState || state.status === 'starting') && (
            <div className="mt-4 rounded-xl border border-[#BFFF00]/20 bg-[#BFFF00]/[0.06] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.1em] text-[#D8FFA1]">
                Pairing pending
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-white/65">
                Approve the connection in your browser to finish pairing.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={state.connectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 py-1.5 text-[11px] font-semibold text-[#D8FFA1]"
                >
                  Approve in browser
                </a>
                {state.expiresAt && (
                  <span className="text-[11px] text-white/40">
                    Expires {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="text-[12px] font-semibold text-white/80">Key guidance</p>
        <p className="mt-1 text-[12px] leading-relaxed text-white/45">
          Use a user-scoped key (<code className="rounded bg-black/40 px-1">oxk_...</code>) whenever possible.
          User keys do not require a separate userId header.
        </p>
      </div>
    </div>
  );
}
