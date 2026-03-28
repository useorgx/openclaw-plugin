import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { humanizeWarning } from '@/lib/humanize';
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
      ? 'bg-lime'
      : phase === 'connecting'
        ? 'bg-lime'
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
      ? 'text-lime'
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

function ConnectionStepRail({
  phase,
  hasApiKey,
  verified,
  workspaceName,
}: {
  phase: ConnectionPhase;
  hasApiKey: boolean;
  verified: boolean;
  workspaceName?: string | null;
}) {
  const steps = [
    {
      id: 'connect',
      label: 'Connect',
      detail: 'Provide credentials',
      done: hasApiKey || verified,
    },
    {
      id: 'verify',
      label: 'Verify',
      detail: 'Confirm live sync',
      done: verified,
    },
    {
      id: 'scope',
      label: 'Scope',
      detail: workspaceName ? workspaceName : 'Select workspace',
      done: phase === 'connected',
    },
  ];

  const activeStep =
    phase === 'connecting'
      ? 'verify'
      : phase === 'connected'
        ? 'scope'
        : hasApiKey
          ? 'verify'
          : 'connect';

  return (
    <ol className="grid gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-3 md:grid-cols-3">
      {steps.map((step, index) => {
        const active = step.id === activeStep;
        return (
          <li key={step.id} className="relative min-w-0">
            {index > 0 ? (
              <span
                className="pointer-events-none absolute -left-2 top-3 hidden h-px w-2 bg-white/[0.14] md:block"
                aria-hidden
              />
            ) : null}
            <div
              className={cn(
                'rounded-lg border px-2.5 py-2',
                step.done
                  ? 'border-lime/26 bg-lime/[0.08]'
                  : active
                    ? 'border-teal/28 bg-teal/[0.10]'
                    : 'border-white/[0.10] bg-white/[0.02]'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-semibold',
                    step.done
                      ? 'border-lime/35 bg-lime/[0.18] text-lime'
                      : active
                        ? 'border-teal/35 bg-teal/[0.16] text-teal-100'
                        : 'border-white/[0.14] bg-white/[0.03] text-secondary'
                  )}
                >
                  {index + 1}
                </span>
                <p className="truncate text-caption font-semibold text-primary">{step.label}</p>
              </div>
              <p className="mt-1 truncate text-micro text-secondary">{step.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectionMetaRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-caption">
      <span className="text-secondary">{label}</span>
      <span className="text-primary">{value}</span>
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
  workspaceOptions,
  selectedWorkspaceId,
  onSelectWorkspace,
  onRefresh,
  onStartPairing,
  onCancelPairing,
  onSubmitManualKey,
  onBackToPairing,
  onUseManualKey,
  onDisconnect,
}: {
  state: OnboardingState;
  isStarting: boolean;
  isSubmittingManual: boolean;
  workspaceOptions: Array<{ id: string; title: string }>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
  onRefresh: () => Promise<unknown>;
  onStartPairing: () => Promise<void>;
  onCancelPairing: () => Promise<unknown>;
  onSubmitManualKey: (apiKey: string) => Promise<unknown>;
  onBackToPairing: () => void;
  onUseManualKey: () => void;
  onDisconnect: () => Promise<unknown>;
}) {
  const settingsUrl = 'https://www.useorgx.com/settings#security';
  const phase = derivePhase(state.status, state.connectionVerified);
  const showManual = state.status === 'manual_key';
  const showPairing =
    (state.status === 'awaiting_browser_auth' || state.status === 'pairing' || state.status === 'starting') ||
    (phase === 'connected' &&
      typeof state.pairingId === 'string' &&
      state.pairingId.trim().length > 0 &&
      typeof state.connectUrl === 'string' &&
      state.connectUrl.trim().length > 0);
  const hasError = Boolean(state.lastError);
  const friendlyLastError = state.lastError ? humanizeWarning(state.lastError) : null;
  const keyLabel = keySourceHuman(state.keySource);

  const subtitle = useMemo(() => {
    if (phase === 'connected' && showPairing) {
      return 'A reconnect is pending in the browser. Your current OrgX session stays live until approval completes.';
    }
    if (phase === 'connected') return 'Live sync is active. Initiatives, tasks, and activity flow in real time.';
    if (phase === 'connecting') return 'Approve the pairing in your browser to finish connecting.';
    if (phase === 'error') return 'Trouble reaching OrgX. Try reconnecting or use a manual API key.';
    if (state.hasApiKey) return 'An API key is present but the connection has not been verified yet.';
    return 'Connect to OrgX to sync initiatives, tasks, activity, and decisions.';
  }, [phase, showPairing, state.hasApiKey]);

  // Border glow varies by state
  const cardBorder =
    phase === 'connected'
      ? 'border-lime/15'
      : phase === 'error'
        ? 'border-rose-400/20'
        : 'border-white/[0.07]';

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-heading font-semibold text-white">Connection state</h3>
        <p className="mt-1 text-body leading-relaxed text-secondary">{subtitle}</p>
      </div>

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {hasError && (
        <div className="rounded-xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-body text-rose-100">
          {friendlyLastError}
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
            <div>
              <p className="text-micro uppercase tracking-[0.12em] text-lime/80">Live state</p>
              <div className="mt-1">
                <StatusHeadline phase={phase} />
              </div>
            </div>
            <button
              type="button"
              onClick={() => { void onRefresh(); }}
              className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Refresh
            </button>
          </div>

          <div className="mt-4 grid gap-3">
            <div>
              <p className="mb-2 text-micro uppercase tracking-[0.12em] text-secondary">Lifecycle</p>
              <ConnectionStepRail
                phase={phase}
                hasApiKey={state.hasApiKey}
                verified={state.connectionVerified}
                workspaceName={state.workspaceName}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
                <p className="text-micro uppercase tracking-[0.12em] text-muted">Credentials</p>
                <div className="mt-2.5 grid gap-1.5">
                  <ConnectionMetaRow
                    label="API key"
                    value={state.hasApiKey ? 'Detected' : 'Missing'}
                  />
                  <ConnectionMetaRow
                    label="Verification"
                    value={state.connectionVerified ? 'Verified' : 'Not verified'}
                  />
                  <ConnectionMetaRow
                    label="Source"
                    value={keyLabel || 'none'}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
                <p className="text-micro uppercase tracking-[0.12em] text-muted">Scope</p>
                {phase === 'connected' ? (
                  <div className="mt-2">
                    <label htmlFor="settings-workspace-scope" className="sr-only">
                      Workspace scope
                    </label>
                    <div className="relative">
                      <select
                        id="settings-workspace-scope"
                        value={selectedWorkspaceId ?? '__all__'}
                        onChange={(event) => {
                          const next = event.target.value;
                          onSelectWorkspace(next === '__all__' ? null : next);
                        }}
                        className="h-9 w-full appearance-none rounded-full border border-strong bg-white/[0.03] pl-3 pr-9 text-body font-semibold text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
                        title="Select workspace scope"
                      >
                        <option value="__all__">All workspaces</option>
                        {workspaceOptions.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.title}
                          </option>
                        ))}
                      </select>
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-secondary"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </div>
                    <p className="mt-1.5 text-caption text-muted">
                      Connected account: <span className="text-secondary">{state.workspaceName ?? 'Unknown'}</span>
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-caption leading-relaxed text-secondary">
                    Selectable after verification completes.
                  </p>
                )}
              </div>
            </div>

            {showPairing && state.connectUrl && (
              <div className="rounded-xl border border-lime/20 bg-lime/[0.06] px-4 py-3">
                <p className="text-caption uppercase tracking-[0.1em] text-lime">Pairing pending</p>
                <p className="mt-1 text-body leading-relaxed text-secondary">
                  {phase === 'connected'
                    ? 'Approve the reconnect in your browser. Your current connection remains active until approval completes.'
                    : 'A browser tab should have opened. Approve the connection to finish.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href={state.connectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-lime/30 bg-lime/15 px-3 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/25"
                  >
                    Open approval page
                  </a>
                  {state.expiresAt && (
                    <span className="text-caption text-muted">
                      Expires {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => { void onCancelPairing(); }}
                    className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                  >
                    Cancel pairing
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* -- Unverified key hint ------------------------------------- */}
          {phase === 'idle' && state.hasApiKey && !state.connectionVerified && (
            <p className="mt-3 text-caption text-amber-200/70">
              Key detected{keyLabel ? ` from ${keyLabel}` : ''} but not yet verified.
              Refresh or reconnect to activate live sync.
            </p>
          )}

          {/* -- Actions -------------------------------------------------- */}
          <div className={cn('mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4')}>
            {phase === 'connected' ? (
              <>
                {/* Connected: secondary actions only */}
                <button
                  type="button"
                  onClick={() => { void onStartPairing(); }}
                  disabled={isStarting || showPairing}
                  className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {showPairing ? 'Reconnect pending' : 'Reconnect'}
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
                  className="inline-flex items-center gap-2 rounded-full bg-lime px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
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
          They activate cleanly without requiring a separate userId header.
        </p>
      )}
    </div>
  );
}
