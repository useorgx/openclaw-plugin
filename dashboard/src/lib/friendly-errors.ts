/**
 * Translate raw error strings into human-friendly messages.
 * Keeps scary internals out of the consumer UI.
 */

export interface FriendlyError {
  title: string;
  detail: string;
  action?: string;
  tone: 'info' | 'warning' | 'error';
  recoverable: boolean;
}

const PATTERNS: [test: RegExp, factory: (match: RegExpMatchArray) => FriendlyError][] = [
  [
    /spawn guard|rate limit/i,
    () => ({
      title: 'Waiting for capacity',
      detail: 'Your tasks will start automatically when a slot opens.',
      action: undefined,
      tone: 'info',
      recoverable: true,
    }),
  ],
  [
    /failed spawn guard/i,
    () => ({
      title: 'Waiting for capacity',
      detail: 'This usually resolves within a few minutes.',
      action: undefined,
      tone: 'info',
      recoverable: true,
    }),
  ],
  [
    /blocked without an explicit reason/i,
    () => ({
      title: 'Paused',
      detail: 'This item was paused without a specific reason.',
      action: 'Resume',
      tone: 'warning',
      recoverable: true,
    }),
  ],
  [
    /run not found/i,
    () => ({
      title: 'Session no longer available',
      detail: 'This session may have been removed or expired.',
      action: undefined,
      tone: 'warning',
      recoverable: false,
    }),
  ],
  [
    /500|internal server error/i,
    () => ({
      title: 'Something went wrong',
      detail: 'An unexpected error occurred on our end.',
      action: 'Retry',
      tone: 'error',
      recoverable: true,
    }),
  ],
  [
    /network|fetch|ECONNREFUSED|timeout/i,
    () => ({
      title: 'Connection issue',
      detail: 'Could not reach the server. Retrying automatically.',
      action: undefined,
      tone: 'warning',
      recoverable: true,
    }),
  ],
  [
    /40[13]/,
    () => ({
      title: 'Access denied',
      detail: 'You may need to reconnect your workspace.',
      action: 'Reconnect',
      tone: 'error',
      recoverable: false,
    }),
  ],
  [
    /\{"error"/i,
    () => ({
      title: 'Something went wrong',
      detail: 'An unexpected error occurred.',
      action: 'Retry',
      tone: 'error',
      recoverable: true,
    }),
  ],
];

export function friendlyError(raw: string): FriendlyError {
  for (const [re, factory] of PATTERNS) {
    const match = raw.match(re);
    if (match) return factory(match);
  }
  return {
    title: 'Something went wrong',
    detail: raw.length > 120 ? `${raw.slice(0, 117)}...` : raw,
    action: 'Retry',
    tone: 'error',
    recoverable: true,
  };
}
