import * as Sentry from '@sentry/node';

const DEFAULT_DSN = '';
const PACKAGE_NAME = '@useorgx/openclaw-plugin';
const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|session|prompt|input|output|completion|model[_-]?(?:input|output))(?:$|[_-])/i;

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function sampleRate(value: string | undefined, fallback = 0.02): number {
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
  if (value instanceof Error) {
    return {
      name: redactText(value.name),
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitize(entry, depth + 1);
  }
  return sanitized;
}

export function initializeOpenClawSentry(version: string): boolean {
  const dsn = process.env.ORGX_SENTRY_DSN?.trim() || DEFAULT_DSN;
  const disabled =
    isTruthy(process.env.ORGX_TELEMETRY_DISABLED) ||
    isTruthy(process.env.OPENCLAW_TELEMETRY_DISABLED) ||
    isTruthy(process.env.ORGX_SENTRY_DISABLED);
  if (!dsn || disabled || Sentry.isInitialized()) return false;

  Sentry.init({
    dsn,
    environment: process.env.ORGX_SENTRY_ENVIRONMENT || 'production',
    release: `${PACKAGE_NAME}@${version}`,
    tracesSampleRate: sampleRate(process.env.ORGX_SENTRY_TRACES_SAMPLE_RATE),
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
      tags: { service: 'orgx-clients', surface: 'openclaw-plugin' },
    },
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

export function captureOpenClawException(
  error: unknown,
  tags: Record<string, string> = {}
): void {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(error, { tags });
}
