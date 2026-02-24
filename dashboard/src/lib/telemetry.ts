type PosthogClient = typeof import('posthog-js').default;

const POSTHOG_KEY = 'phc_s4KPgkYEFZgvkMYw4zXG41H5FN6haVwbEWPYHfNjxOc';
const TELEMETRY_FLAG_ENABLED =
  String(import.meta.env.VITE_ORGX_DASHBOARD_TELEMETRY ?? '')
    .trim()
    .toLowerCase() === 'true' ||
  String(import.meta.env.VITE_ORGX_DASHBOARD_TELEMETRY ?? '').trim() === '1';
const TELEMETRY_FORCE_LOOPBACK =
  String(import.meta.env.VITE_ORGX_DASHBOARD_TELEMETRY_FORCE_LOOPBACK ?? '')
    .trim()
    .toLowerCase() === 'true' ||
  String(import.meta.env.VITE_ORGX_DASHBOARD_TELEMETRY_FORCE_LOOPBACK ?? '').trim() === '1';
const POSTHOG_OPTIONS = {
  api_host: 'https://us.i.posthog.com',
  defaults: '2026-01-30',
  person_profiles: 'identified_only',
} as const;

let posthogClientPromise: Promise<PosthogClient | null> | null = null;
let posthogInitialized = false;
let initScheduled = false;
let telemetrySuppressed = false;

function isLoopbackHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function telemetryEnabled(): boolean {
  if (telemetrySuppressed) return false;
  if (!TELEMETRY_FLAG_ENABLED) return false;
  if (TELEMETRY_FORCE_LOOPBACK) return true;
  // Plugin dashboards run on loopback with restrictive CSP by default.
  // Avoid spinning PostHog retries that flood console/network errors.
  if (isLoopbackHost()) return false;
  return true;
}

function loadPosthogClient(): Promise<PosthogClient | null> {
  if (!telemetryEnabled()) return Promise.resolve(null);
  if (!posthogClientPromise) {
    posthogClientPromise = import('posthog-js')
      .then((module) => module.default)
      .catch(() => {
        telemetrySuppressed = true;
        return null;
      });
  }
  return posthogClientPromise;
}

function ensurePosthogInitialized(client: PosthogClient): boolean {
  if (posthogInitialized) return true;
  try {
    client.init(POSTHOG_KEY, POSTHOG_OPTIONS as any);
    posthogInitialized = true;
    return true;
  } catch {
    telemetrySuppressed = true;
    return false;
  }
}

async function resolvePosthog(): Promise<PosthogClient | null> {
  const client = await loadPosthogClient();
  if (!client) return null;
  if (!ensurePosthogInitialized(client)) return null;
  return client;
}

function scheduleIdle(callback: () => void): void {
  if (typeof window === 'undefined') return;
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  };
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => callback(), { timeout: 1_500 });
    return;
  }
  window.setTimeout(callback, 1);
}

export function initTelemetry(): void {
  if (!telemetryEnabled() || typeof window === 'undefined' || initScheduled) return;
  initScheduled = true;
  scheduleIdle(() => {
    void resolvePosthog();
  });
}

export function identifyTelemetry(distinctId: string): void {
  if (!telemetryEnabled()) return;
  const normalizedId = distinctId.trim();
  if (!normalizedId) return;
  void resolvePosthog().then((client) => {
    if (!client) return;
    try {
      client.identify(normalizedId);
    } catch {
      // best effort
    }
  });
}

export function captureTelemetry(event: string, properties?: Record<string, unknown>): void {
  if (!telemetryEnabled()) return;
  if (!event.trim()) return;
  void resolvePosthog().then((client) => {
    if (!client) return;
    try {
      client.capture(event, properties);
    } catch {
      // best effort
    }
  });
}
