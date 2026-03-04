import { humanizeWarning } from '@/lib/humanize';

export class MissionControlApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly errorLocation: string | null;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;

  constructor(input: {
    message: string;
    status: number;
    code?: string | null;
    errorLocation?: string | null;
    retryable?: boolean;
    details?: Record<string, unknown> | null;
  }) {
    super(input.message);
    this.name = 'MissionControlApiError';
    this.status = input.status;
    this.code = input.code ?? null;
    this.errorLocation = input.errorLocation ?? null;
    this.retryable = input.retryable ?? false;
    this.details = input.details ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isUnknownApiEndpointError(response: Response, body: Record<string, unknown> | null): boolean {
  if (response.status !== 404) return false;
  const error = pickString(body, ['error']) ?? '';
  const message = pickString(body, ['message']) ?? '';
  return /unknown api endpoint/i.test(`${error} ${message}`);
}

function normalizeFallbackMessage(
  response: Response,
  body: Record<string, unknown> | null,
  fallback: string
): string {
  if (isUnknownApiEndpointError(response, body)) {
    return `${fallback}. This queue control is unavailable in the running plugin build.`;
  }
  if (response.status === 401 || response.status === 403) {
    return `${fallback}. Reconnect OrgX authentication in Settings.`;
  }
  if (response.status >= 500) {
    return `${fallback}. OrgX is temporarily unavailable.`;
  }
  const detail = pickString(body, ['error', 'message']) ?? `${fallback} (${response.status})`;
  return humanizeWarning(detail);
}

export function parseMissionControlApiError(
  response: Response,
  body: unknown,
  fallback: string
): MissionControlApiError {
  const record = asRecord(body);
  const message = normalizeFallbackMessage(response, record, fallback);
  const code = pickString(record, ['code']);
  const errorLocation = pickString(record, ['error_location', 'errorLocation']);
  const retryableValue = record?.retryable;
  const retryable = typeof retryableValue === 'boolean' ? retryableValue : false;

  return new MissionControlApiError({
    message,
    status: response.status,
    code,
    errorLocation,
    retryable,
    details: record,
  });
}

export function isMissionControlApiError(error: unknown): error is MissionControlApiError {
  return error instanceof MissionControlApiError;
}
