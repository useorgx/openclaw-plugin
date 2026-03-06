import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { identifyTelemetry } from '@/lib/telemetry';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { humanizeWarning } from '@/lib/humanize';

import type { OnboardingState } from '@/types';

const DEFAULT_DOCS_URL = 'https://orgx.mintlify.site/guides/openclaw-plugin-setup';
const DEFAULT_POLL_MS = 1500;
const ONBOARDING_SKIP_STORAGE_KEY = 'orgx.onboarding.skip';
const PAIRING_INTERSTITIAL_DELAY_MS = 680;
const PAIRING_INTERSTITIAL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connecting to OrgX</title>
    <style>
      :root {
        --bg: #02040a;
        --surface: #0c0e14;
        --surface-soft: #0f121a;
        --line: rgba(255, 255, 255, 0.1);
        --text: #f2f7ff;
        --muted: rgba(242, 247, 255, 0.62);
        --lime: #bfff00;
        --teal: #14b8a6;
        --iris: #7c7cff;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(920px 460px at 14% 14%, rgba(124, 124, 255, 0.12), transparent 68%),
          radial-gradient(840px 420px at 84% 88%, rgba(20, 184, 166, 0.12), transparent 72%),
          var(--bg);
        color: var(--text);
        font-family: "SF Pro Text", "SF Pro Display", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 24px;
      }

      .shell {
        width: min(640px, 100%);
        border-radius: 22px;
        border: 1px solid var(--line);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015)),
          var(--surface);
        box-shadow:
          0 28px 80px rgba(0, 0, 0, 0.58),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(0, 0, 0, 0.16);
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }

      .brand-mark {
        width: 22px;
        height: 22px;
        color: var(--lime);
        opacity: 0.95;
      }

      .brand-name {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: rgba(242, 247, 255, 0.92);
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid rgba(191, 255, 0, 0.3);
        background: rgba(191, 255, 0, 0.12);
        color: #d8ffa1;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--lime);
        box-shadow: 0 0 0 0 rgba(191, 255, 0, 0.56);
        animation: pulse 1.6s infinite ease-out;
      }

      .content {
        padding: 20px 20px 18px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.18;
        letter-spacing: -0.02em;
      }

      .subtitle {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }

      .steps {
        margin-top: 16px;
        display: grid;
        gap: 8px;
      }

      .step {
        display: flex;
        align-items: center;
        gap: 9px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: var(--surface-soft);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
      }

      .step svg {
        flex-shrink: 0;
        width: 14px;
        height: 14px;
      }

      .meta {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        color: rgba(242, 247, 255, 0.42);
        font-size: 11px;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(191, 255, 0, 0.56); }
        100% { box-shadow: 0 0 0 12px rgba(191, 255, 0, 0); }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="header">
        <div class="brand">
          <svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 7h5.8l6.7 6"></path>
            <path d="M5.5 17h5.8l6.7-6"></path>
            <path d="M5.5 12h12.5"></path>
            <path d="m15.3 9.3 2.7 2.7-2.7 2.7"></path>
          </svg>
          <span class="brand-name">OrgX</span>
        </div>
        <div class="chip"><span class="dot"></span>Pairing</div>
      </header>
      <section class="content">
        <h1>Connecting to OrgX</h1>
        <p class="subtitle">Preparing a secure workspace session. This window will continue automatically.</p>
        <div class="steps">
          <div class="step">
            <svg viewBox="0 0 24 24" fill="none" stroke="#7C7CFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <circle cx="12" cy="12" r="4.5"></circle>
            </svg>
            <span>Initializing plugin handshake</span>
          </div>
          <div class="step">
            <svg viewBox="0 0 24 24" fill="none" stroke="#14B8A6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 3v18"></path>
              <path d="m5 4 12 1-2 4 2 4-12-1z"></path>
            </svg>
            <span>Opening browser approval for this workspace</span>
          </div>
          <div class="step">
            <svg viewBox="0 0 24 24" fill="none" stroke="#BFFF00" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="4"></rect>
              <path d="M9 12.2 11 14.2 15.2 10"></path>
            </svg>
            <span>Syncing initiatives, tasks, and decisions</span>
          </div>
        </div>
        <div class="meta">If redirect does not start, return to OpenClaw and click “Approve in browser”.</div>
      </section>
    </main>
  </body>
</html>`;

const DEFAULT_STATE: OnboardingState = {
  status: 'idle',
  hasApiKey: false,
  connectionVerified: false,
  workspaceName: null,
  lastError: null,
  nextAction: 'connect',
  docsUrl: DEFAULT_DOCS_URL,
  keySource: 'none',
  installationId: null,
  connectUrl: null,
  pairingId: null,
  expiresAt: null,
  pollIntervalMs: null,
};

function mergeOnboardingState(
  previous: OnboardingState,
  next: OnboardingState
): OnboardingState {
  const preserveVerifiedContext = previous.hasApiKey && previous.connectionVerified;
  const merged: OnboardingState = {
    ...previous,
    ...next,
    docsUrl: next.docsUrl ?? previous.docsUrl ?? DEFAULT_DOCS_URL,
  };

  if (
    preserveVerifiedContext &&
    (next.status === 'pairing' || next.status === 'awaiting_browser_auth')
  ) {
    merged.hasApiKey = true;
    merged.connectionVerified = true;
    merged.workspaceName = previous.workspaceName ?? next.workspaceName ?? null;
  } else if (!next.workspaceName && previous.workspaceName) {
    merged.workspaceName = previous.workspaceName;
  }

  if ((!next.installationId || next.installationId.trim().length === 0) && previous.installationId) {
    merged.installationId = previous.installationId;
  }

  if ((next.keySource === 'none' || !next.keySource) && previous.keySource && previous.keySource !== 'none') {
    merged.keySource = previous.keySource;
  }

  return merged;
}

function buildOnboardingErrorState(
  previous: OnboardingState,
  message: string
): OnboardingState {
  if (previous.hasApiKey || previous.connectionVerified || previous.workspaceName) {
    return {
      ...previous,
      lastError: message,
      nextAction: previous.nextAction ?? 'connect',
    };
  }

  return {
    ...DEFAULT_STATE,
    status: 'error',
    lastError: message,
    nextAction: 'retry',
  };
}

function buildDemoOnboardingState(): OnboardingState {
  return {
    ...DEFAULT_STATE,
    status: 'connected',
    hasApiKey: true,
    connectionVerified: true,
    workspaceName: 'Demo Workspace',
    nextAction: 'open_dashboard',
    keySource: 'legacy-dev',
    lastError: null,
  };
}

interface ApiResponse<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

function extractError(value: unknown): string | undefined {
  if (typeof value === 'string') return humanizeWarning(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.error === 'string') return humanizeWarning(record.error);
    if (typeof record.message === 'string') return humanizeWarning(record.message);
  }
  return undefined;
}

async function readJson<T>(request: Promise<Response>): Promise<ApiResponse<T>> {
  const response = await request;
  const payload = (await response.json().catch(() => null)) as
    | (ApiResponse<T> & { message?: unknown })
    | null;
  if (!response.ok) {
    const extracted =
      extractError(payload?.error) ??
      extractError(payload?.message) ??
      extractError(payload);
    return {
      ok: false,
      error: extracted ?? humanizeWarning(`Request failed (${response.status})`),
    };
  }
  return payload ?? {};
}

function maybeIdentify(installationId: string | null | undefined) {
  if (!installationId) return;
  try {
    // Keep dashboard + plugin runtime events correlated on the same distinct_id.
    identifyTelemetry(installationId);
  } catch {
    // best effort
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(() =>
    isDemoModeEnabled() ? buildDemoOnboardingState() : DEFAULT_STATE
  );
  const stateRef = useRef(state);
  const [isLoading, setIsLoading] = useState(() => !isDemoModeEnabled());
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);
  const pairingWindowRef = useRef<Window | null>(null);
  const [isGateSkipped, setIsGateSkipped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(ONBOARDING_SKIP_STORAGE_KEY) === '1';
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshStatus = useCallback(async (): Promise<OnboardingState> => {
    if (isDemoModeEnabled()) {
      const demoState = buildDemoOnboardingState();
      setState(demoState);
      return demoState;
    }

    const payload = await readJson<OnboardingState>(
      fetch('/orgx/api/onboarding/status', { method: 'GET' })
    );

    if (!payload.ok || !payload.data) {
      const message = payload.error ?? 'Failed to load onboarding state';
      const fallback = buildOnboardingErrorState(stateRef.current, message);
      setState(fallback);
      return fallback;
    }

    const merged = mergeOnboardingState(stateRef.current, payload.data);
    maybeIdentify(merged.installationId ?? null);
    setState(merged);
    return merged;
  }, []);

  useEffect(() => {
    if (isDemoModeEnabled()) {
      setState(buildDemoOnboardingState());
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      setIsLoading(true);
      const next = await refreshStatus();
      if (!cancelled) {
        setState(next);
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  useEffect(() => {
    const shouldPoll =
      state.status === 'awaiting_browser_auth' ||
      state.status === 'pairing' ||
      (state.status === 'connected' &&
        typeof state.pairingId === 'string' &&
        state.pairingId.trim().length > 0 &&
        typeof state.connectUrl === 'string' &&
        state.connectUrl.trim().length > 0);
    if (!shouldPoll) return undefined;

    const intervalMs = Math.max(900, state.pollIntervalMs ?? DEFAULT_POLL_MS);
    const timer = window.setInterval(async () => {
      const payload = await readJson<OnboardingState>(
        fetch('/orgx/api/onboarding/status', { method: 'GET' })
      );
      if (payload.ok && payload.data) {
        const merged = mergeOnboardingState(stateRef.current, payload.data);
        maybeIdentify(merged.installationId ?? null);
        setState(merged);
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [state.connectUrl, state.connectionVerified, state.pairingId, state.pollIntervalMs, state.status]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isGateSkipped) {
      window.localStorage.setItem(ONBOARDING_SKIP_STORAGE_KEY, '1');
      return;
    }
    window.localStorage.removeItem(ONBOARDING_SKIP_STORAGE_KEY);
  }, [isGateSkipped]);

  const openPairingWindow = useCallback(() => {
    if (typeof window === 'undefined') return null;
    try {
      const win = window.open('', '_blank');
      if (!win) return null;
      win.opener = null;
      win.document.title = 'Connecting to OrgX…';
      win.document.open();
      win.document.write(PAIRING_INTERSTITIAL_HTML);
      win.document.close();
      return win;
    } catch {
      return null;
    }
  }, []);

  const startPairing = useCallback(async () => {
    if (isDemoModeEnabled()) {
      const demoState = buildDemoOnboardingState();
      setState(demoState);
      return;
    }

    const pairingWindow = openPairingWindow();
    pairingWindowRef.current = pairingWindow;

    setIsStarting(true);
    try {
      const payload = await readJson<{
        pairingId: string;
        connectUrl: string;
        expiresAt: string;
        pollIntervalMs: number;
        state: OnboardingState;
      }>(
        fetch('/orgx/api/onboarding/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceName: navigator.platform || 'OpenClaw Device',
            platform: navigator.platform,
          }),
        })
      );

      const data = payload.data;
      if (!payload.ok || !data?.state) {
        if (pairingWindow && !pairingWindow.closed) {
          pairingWindow.close();
        }
        const message = payload.error ?? 'Could not start pairing';
        setState((previous) => ({
          ...previous,
          status: 'error',
          lastError: message,
          nextAction: 'enter_manual_key',
        }));
        return;
      }

      setState(mergeOnboardingState(stateRef.current, data.state));
      const connectUrl = data.connectUrl;
      if (connectUrl) {
        const targetWindow = pairingWindowRef.current;
        let opened = false;

        if (targetWindow && !targetWindow.closed) {
          try {
            window.setTimeout(() => {
              if (!targetWindow.closed) {
                try {
                  targetWindow.location.href = connectUrl;
                } catch {
                  // Ignore navigation errors; fallback path below handles blocked popups.
                }
              }
            }, PAIRING_INTERSTITIAL_DELAY_MS);
            opened = true;
          } catch {
            opened = false;
          }
        }

        if (!opened) {
          const fallback = window.open(connectUrl, '_blank', 'noopener,noreferrer');
          opened = Boolean(fallback);
        }

        if (!opened) {
          setState((previous) => ({
            ...previous,
            lastError: 'Popup was blocked. Use "Approve in browser" below.',
            nextAction: 'open_browser',
          }));
        }
      }
    } finally {
      pairingWindowRef.current = null;
      setIsStarting(false);
    }
  }, [openPairingWindow]);

  const submitManualKey = useCallback(
    async (apiKey: string) => {
      if (isDemoModeEnabled()) {
        const demoState = buildDemoOnboardingState();
        setState(demoState);
        return demoState;
      }

      setIsSubmittingManual(true);
      try {
        const trimmedInput = apiKey.trim();
        const keyBody = trimmedInput.replace(/^[a-z]+_/i, '');
        const candidates = Array.from(
          new Set(
            [trimmedInput, keyBody ? `oxk_${keyBody}` : '', keyBody ? `orgx_${keyBody}` : '']
              .map((candidate) => candidate.trim())
              .filter((candidate) => candidate.length > 0)
          )
        );

        let lastError = 'Manual key validation failed';

        for (const candidate of candidates) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-OrgX-Api-Key': candidate,
            Authorization: `Bearer ${candidate}`,
          };

          const payload = await readJson<OnboardingState>(
            fetch('/orgx/api/onboarding/manual-key', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                apiKey: candidate,
              }),
            })
          );

          if (payload.ok && payload.data) {
            const merged = mergeOnboardingState(stateRef.current, payload.data);
            maybeIdentify(merged.installationId ?? null);
            setState(merged);
            return merged;
          }

          lastError = payload.error ?? lastError;
        }

        setState((previous) => ({
          ...previous,
          status: 'manual_key',
          lastError,
          nextAction: 'enter_manual_key',
        }));
        throw new Error(lastError);
      } finally {
        setIsSubmittingManual(false);
      }
    },
    []
  );

  const disconnect = useCallback(async () => {
    if (isDemoModeEnabled()) {
      const demoState = buildDemoOnboardingState();
      setState(demoState);
      return demoState;
    }

    const payload = await readJson<OnboardingState>(
      fetch('/orgx/api/onboarding/disconnect', {
        method: 'POST',
      })
    );

    if (payload.ok && payload.data) {
      const merged = mergeOnboardingState(stateRef.current, payload.data);
      maybeIdentify(merged.installationId ?? null);
      setState(merged);
      return merged;
    }

    const fallback: OnboardingState = {
      ...DEFAULT_STATE,
      status: 'idle',
    };
    setState(fallback);
    return fallback;
  }, []);

  const cancelPairing = useCallback(async () => {
    if (isDemoModeEnabled()) {
      const demoState = buildDemoOnboardingState();
      setState(demoState);
      return demoState;
    }

    const payload = await readJson<OnboardingState>(
      fetch('/orgx/api/onboarding/cancel', {
        method: 'POST',
      })
    );

    if (payload.ok && payload.data) {
      const merged = mergeOnboardingState(stateRef.current, payload.data);
      maybeIdentify(merged.installationId ?? null);
      setState(merged);
      return merged;
    }

    const next = await refreshStatus();
    setState(next);
    return next;
  }, [refreshStatus]);

  const backToPairing = useCallback(() => {
    setState((previous) => ({
      ...previous,
      status: 'idle',
      lastError: null,
      nextAction: 'connect',
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }));
  }, []);

  const showGate = useMemo(() => {
    if (isDemoModeEnabled()) return false;
    if (isGateSkipped) return false;
    const connectionStillUsable =
      state.hasApiKey &&
      state.connectionVerified &&
      (state.status === 'connected' ||
        state.status === 'pairing' ||
        state.status === 'awaiting_browser_auth');
    return !connectionStillUsable;
  }, [isGateSkipped, state.connectionVerified, state.hasApiKey, state.status]);

  return {
    state,
    showGate,
    isLoading,
    isStarting,
    isSubmittingManual,
    refreshStatus,
    startPairing,
    submitManualKey,
    cancelPairing,
    disconnect,
    skipGate: () => setIsGateSkipped(true),
    resumeGate: () => setIsGateSkipped(false),
    backToPairing,
    setManualMode: () =>
      setState((previous) => ({
        ...previous,
        status: 'manual_key',
        nextAction: 'enter_manual_key',
      })),
  };
}
