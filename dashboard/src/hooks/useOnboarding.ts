import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OnboardingState } from '@/types';

const DEFAULT_DOCS_URL = 'https://orgx.mintlify.site/guides/openclaw-plugin-setup';
const DEFAULT_POLL_MS = 1500;
const ONBOARDING_SKIP_STORAGE_KEY = 'orgx.onboarding.skip';

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

interface ApiResponse<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

function extractError(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

async function readJson<T>(request: Promise<Response>): Promise<ApiResponse<T>> {
  const response = await request;
  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!response.ok) {
    return {
      ok: false,
      error: extractError(payload?.error) ?? `Request failed (${response.status})`,
    };
  }
  return payload ?? {};
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);
  const pairingWindowRef = useRef<Window | null>(null);
  const [isGateSkipped, setIsGateSkipped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(ONBOARDING_SKIP_STORAGE_KEY) === '1';
  });

  const refreshStatus = useCallback(async (): Promise<OnboardingState> => {
    const payload = await readJson<OnboardingState>(
      fetch('/orgx/api/onboarding/status', { method: 'GET' })
    );

    if (!payload.ok || !payload.data) {
      const message = payload.error ?? 'Failed to load onboarding state';
      const fallback: OnboardingState = {
        ...DEFAULT_STATE,
        status: 'error',
        lastError: message,
        nextAction: 'retry',
      };
      setState(fallback);
      return fallback;
    }

    setState(payload.data);
    return payload.data;
  }, []);

  useEffect(() => {
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
      state.status === 'awaiting_browser_auth' || state.status === 'pairing';
    if (!shouldPoll) return undefined;

    const intervalMs = Math.max(900, state.pollIntervalMs ?? DEFAULT_POLL_MS);
    const timer = window.setInterval(async () => {
      const payload = await readJson<OnboardingState>(
        fetch('/orgx/api/onboarding/status', { method: 'GET' })
      );
      if (payload.ok && payload.data) {
        setState(payload.data);
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [state.pollIntervalMs, state.status]);

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
      win.document.body.innerHTML =
        '<div style="font-family:system-ui,-apple-system,sans-serif;padding:20px;color:#111">Connecting to OrgX...</div>';
      return win;
    } catch {
      return null;
    }
  }, []);

  const startPairing = useCallback(async () => {
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

      if (!payload.ok || !payload.data?.state) {
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

      setState(payload.data.state);
      if (payload.data.connectUrl) {
        const targetWindow = pairingWindowRef.current;
        let opened = false;

        if (targetWindow && !targetWindow.closed) {
          try {
            targetWindow.location.href = payload.data.connectUrl;
            opened = true;
          } catch {
            opened = false;
          }
        }

        if (!opened) {
          const fallback = window.open(payload.data.connectUrl, '_blank', 'noopener,noreferrer');
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
            setState(payload.data);
            return payload.data;
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
    const payload = await readJson<OnboardingState>(
      fetch('/orgx/api/onboarding/disconnect', {
        method: 'POST',
      })
    );

    if (payload.ok && payload.data) {
      setState(payload.data);
      return payload.data;
    }

    const fallback: OnboardingState = {
      ...DEFAULT_STATE,
      status: 'idle',
    };
    setState(fallback);
    return fallback;
  }, []);

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
    if (isGateSkipped) return false;
    return !(state.hasApiKey && state.connectionVerified && state.status === 'connected');
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
