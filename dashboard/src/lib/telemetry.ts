type PosthogClient = typeof import('posthog-js').default;

const POSTHOG_KEY = 'phc_s4KPgkYEFZgvkMYw4zXG41H5FN6haVwbEWPYHfNjxOc';
const POSTHOG_OPTIONS = {
  api_host: 'https://us.i.posthog.com',
  defaults: '2026-01-30',
  person_profiles: 'identified_only',
} as const;

let posthogClientPromise: Promise<PosthogClient | null> | null = null;
let posthogInitialized = false;
let initScheduled = false;

function loadPosthogClient(): Promise<PosthogClient | null> {
  if (!posthogClientPromise) {
    posthogClientPromise = import('posthog-js')
      .then((module) => module.default)
      .catch(() => null);
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
  if (typeof window === 'undefined' || initScheduled) return;
  initScheduled = true;
  scheduleIdle(() => {
    void resolvePosthog();
  });
}

export function identifyTelemetry(distinctId: string): void {
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
