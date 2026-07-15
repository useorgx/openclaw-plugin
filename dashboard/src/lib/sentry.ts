import * as Sentry from '@sentry/react';
import { replayIntegration } from '@sentry/replay';

declare const __ORGX_PLUGIN_VERSION__: string;
declare const __ORGX_SENTRY_DSN__: string;

const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|session|prompt|input|output|completion|model[_-]?(?:input|output))(?:$|[_-])/i;

function sampleRate(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsntrys_[A-Za-z0-9_-]+\b/g, 'sntrys_[redacted]')
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/\/home\/[^/\s]+/g, '/home/[user]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]');
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitize(entry, depth + 1);
  }
  return sanitized;
}

export function initDashboardSentry(): boolean {
  const dsn =
    String(import.meta.env.VITE_ORGX_SENTRY_DSN ?? '').trim() ||
    __ORGX_SENTRY_DSN__;
  const disabled =
    String(import.meta.env.VITE_ORGX_SENTRY_DISABLED ?? '').trim() === '1' ||
    window.localStorage.getItem('orgx.telemetry.disabled') === '1';
  if (!dsn || disabled) return false;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: `@useorgx/openclaw-plugin@${__ORGX_PLUGIN_VERSION__}`,
    tracesSampleRate: import.meta.env.PROD
      ? sampleRate(import.meta.env.VITE_ORGX_SENTRY_TRACES_SAMPLE_RATE, 0.02)
      : 0,
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 3,
    },
    initialScope: {
      tags: { service: 'orgx-clients', surface: 'openclaw-dashboard' },
    },
    integrations: [
      replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    replaysSessionSampleRate: import.meta.env.PROD
      ? sampleRate(import.meta.env.VITE_ORGX_SENTRY_REPLAYS_SESSION_SAMPLE_RATE, 0.02)
      : 0,
    replaysOnErrorSampleRate: sampleRate(
      import.meta.env.VITE_ORGX_SENTRY_REPLAYS_ERROR_SAMPLE_RATE,
      1
    ),
    tracePropagationTargets: [/^\//, /^https:\/\/([a-z0-9-]+\.)*useorgx\.com\//i],
    beforeBreadcrumb: (breadcrumb) =>
      breadcrumb.category === 'console'
        ? null
        : (sanitize(breadcrumb) as typeof breadcrumb),
    beforeSend(event) {
      const sanitized = sanitize(event) as typeof event;
      delete sanitized.user;
      delete sanitized.request;
      return sanitized;
    },
    beforeSendTransaction: (event) => sanitize(event) as typeof event,
    beforeSendLog: (log) => sanitize(log) as typeof log,
  });
  return true;
}

export { Sentry };
