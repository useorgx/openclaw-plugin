import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OnboardingState } from '@/types';

const DEFAULT_DOCS_URL = 'https://orgx.mintlify.site/guides/openclaw-plugin-setup';
const DEFAULT_POLL_MS = 1500;

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

async function readJson<T>(request: Promise<Response>): Promise<ApiResponse<T>> {
  const response = await request;
  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!response.ok) {
    return {
      ok: false,
      error: payload?.error ?? `Request failed (${response.status})`,
    };
  }
  return payload ?? {};
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);

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

  const startPairing = useCallback(async () => {
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
        window.open(payload.data.connectUrl, '_blank', 'noopener,noreferrer');
      }
    } finally {
      setIsStarting(false);
    }
  }, []);

  const submitManualKey = useCallback(
    async (apiKey: string, userId?: string) => {
      setIsSubmittingManual(true);
      try {
        const payload = await readJson<OnboardingState>(
          fetch('/orgx/api/onboarding/manual-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiKey,
              userId,
            }),
          })
        );

        if (!payload.ok || !payload.data) {
          const message = payload.error ?? 'Manual key validation failed';
          setState((previous) => ({
            ...previous,
            status: 'manual_key',
            lastError: message,
            nextAction: 'enter_manual_key',
          }));
          throw new Error(message);
        }

        setState(payload.data);
        return payload.data;
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

  const showGate = useMemo(
    () => !(state.hasApiKey && state.connectionVerified && state.status === 'connected'),
    [state.connectionVerified, state.hasApiKey, state.status]
  );

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
    setManualMode: () =>
      setState((previous) => ({
        ...previous,
        status: 'manual_key',
        nextAction: 'enter_manual_key',
      })),
  };
}
