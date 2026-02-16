import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { OnboardingState, OnboardingStatus } from '@/types';
import { ManualKeyPanel } from '@/components/onboarding/ManualKeyPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keySourceHuman(source: OnboardingState['keySource']): string {
  switch (source) {
    case 'config':
      return 'plugin configuration';
    case 'environment':
      return 'environment variable';
    case 'persisted':
      return 'saved credentials';
    case 'openclaw-config-file':
      return 'OpenClaw config';
    case 'legacy-dev':
      return 'legacy key';
    default:
      return '';
  }
}

type ConnectionPhase = 'connected' | 'connecting' | 'error' | 'idle';

function derivePhase(status: OnboardingStatus, verified: boolean): ConnectionPhase {
  if (status === 'connected' && verified) return 'connected';
  if (status === 'awaiting_browser_auth' || status === 'pairing' || status === 'starting') return 'connecting';
  if (status === 'error') return 'error';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusDot({ phase }: { phase: ConnectionPhase }) {
  const color =
    phase === 'connected'
      ? 'bg-[#BFFF00]'
      : phase === 'connecting'
        ? 'bg-[#BFFF00]'
        : phase === 'error'
          ? 'bg-red-400'
          : 'bg-white/30';
  const pulse = phase === 'connecting';

  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-40', color)} />
      )}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
    </span>
  );
}

function StatusHeadline({ phase }: { phase: ConnectionPhase }) {
  const label =
    phase === 'connected'
      ? 'Connected'
      : phase === 'connecting'
        ? 'Connecting...'
        : phase === 'error'
          ? 'Connection issue'
          : 'Not connected';

  const color =
    phase === 'connected'
      ? 'text-[#BFFF00]'
      : phase === 'error'
        ? 'text-red-400'
        : 'text-primary';

  return (
    <div className="flex items-center gap-2.5">
      <StatusDot phase={phase} />
      <span className={cn('text-body font-semibold', color)}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

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
  const phase = derivePhase(state.status, state.connectionVerified);
  const showManual = state.status === 'manual_key';
  const showPairing =
    state.status === 'awaiting_browser_auth' || state.status === 'pairing' || state.status === 'starting';
  const hasError = Boolean(state.lastError);
  const keyLabel = keySourceHuman(state.keySource);

  const subtitle = useMemo(() => {
    if (phase === 'connected') return 'Live sync is active. Initiatives, tasks, and activity flow in real time.';
    if (phase === 'connecting') return 'Approve the pairing in your browser to finish connecting.';
    if (phase === 'error') return 'Trouble reaching OrgX. Try reconnecting or use a manual API key.';
    if (state.hasApiKey) return 'An API key is present but the connection has not been verified yet.';
    return 'Connect to OrgX to sync initiatives, tasks, activity, and decisions.';
  }, [phase, state.hasApiKey]);

  // Border glow varies by state
  const cardBorder =
    phase === 'connected'
      ? 'border-[#BFFF00]/15'
      : phase === 'error'
        ? 'border-rose-400/20'
        : 'border-white/[0.07]';

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-heading font-semibold text-white">OrgX connection</h3>
        <p className="mt-1 text-body leading-relaxed text-secondary">{subtitle}</p>
      </div>

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {hasError && (
        <div className="rounded-xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-body text-rose-100">
          {state.lastError}
        </div>
      )}

      {/* ── Manual key form (replaces the main card when active) ─────── */}
      {showManual ? (
        <ManualKeyPanel
          isSubmitting={isSubmittingManual}
          onSubmit={onSubmitManualKey}
          onBack={onBackToPairing}
        />
      ) : (
        <div className={cn('rounded-2xl border bg-white/[0.02] p-5', cardBorder)}>
          {/* -- Status row ------------------------------------------------ */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusHeadline phase={phase} />

            <button
              type="button"
              onClick={() => { void onRefresh(); }}
              className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Refresh
            </button>
          </div>

          {/* -- Connection metadata (only when connected) ---------------- */}
          {phase === 'connected' && (
            <div className="mt-4 grid gap-1.5 text-body text-secondary">
              {state.workspaceName && (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted">Workspace</span>
                  <span className="text-primary">{state.workspaceName}</span>
                </div>
              )}
              {keyLabel && (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted">Authenticated via</span>
                  <span className="text-primary">{keyLabel}</span>
                </div>
              )}
            </div>
          )}

          {/* -- Unverified key hint ------------------------------------- */}
          {phase === 'idle' && state.hasApiKey && !state.connectionVerified && (
            <p className="mt-3 text-caption text-amber-200/70">
              Key detected{keyLabel ? ` from ${keyLabel}` : ''} but not yet verified.
              Refresh or reconnect to activate live sync.
            </p>
          )}

          {/* -- Pairing progress ---------------------------------------- */}
          {showPairing && state.connectUrl && (
            <div className="mt-4 rounded-xl border border-[#BFFF00]/20 bg-[#BFFF00]/[0.06] px-4 py-3">
              <p className="text-caption uppercase tracking-[0.1em] text-[#D8FFA1]">Pairing pending</p>
              <p className="mt-1 text-body leading-relaxed text-secondary">
                A browser tab should have opened. Approve the connection to finish.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={state.connectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 py-1.5 text-caption font-semibold text-[#D8FFA1] transition-colors hover:bg-[#BFFF00]/25"
                >
                  Open approval page
                </a>
                {state.expiresAt && (
                  <span className="text-caption text-muted">
                    Expires {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* -- Actions -------------------------------------------------- */}
          <div className={cn('flex flex-wrap items-center gap-2', phase === 'connected' ? 'mt-5' : 'mt-4')}>
            {phase === 'connected' ? (
              <>
                {/* Connected: secondary actions only */}
                <button
                  type="button"
                  onClick={() => { void onStartPairing(); }}
                  disabled={isStarting}
                  className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  onClick={() => { void onDisconnect(); }}
                  className="rounded-full border border-rose-300/20 bg-transparent px-4 py-2 text-body font-semibold text-rose-200/70 transition-colors hover:bg-rose-400/10"
                >
                  Disconnect
                </button>
                <a
                  href={settingsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                >
                  Manage API keys
                </a>
              </>
            ) : (
              <>
                {/* Not connected: primary CTA to connect */}
                <button
                  type="button"
                  onClick={() => { void onStartPairing(); }}
                  disabled={isStarting}
                  data-modal-autofocus="true"
                  className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isStarting ? 'Connecting...' : 'Connect in browser'}
                </button>
                <button
                  type="button"
                  onClick={onUseManualKey}
                  className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                >
                  Use API key
                </button>
                {state.hasApiKey && (
                  <button
                    type="button"
                    onClick={() => { void onDisconnect(); }}
                    className="rounded-full border border-rose-300/20 bg-transparent px-4 py-2 text-body font-semibold text-rose-200/70 transition-colors hover:bg-rose-400/10"
                  >
                    Disconnect
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Key guidance (collapsed into a single line, not a card) ───── */}
      {phase !== 'connected' && (
        <p className="text-caption leading-relaxed text-muted">
          Prefer user-scoped keys (<code className="rounded bg-black/40 px-1">oxk_...</code>).
          They don't require a separate userId header.
        </p>
      )}
    </div>
  );
}
