export type UrgencyTone = 'normal' | 'attention' | 'urgent';

/**
 * Human-friendly duration from a raw minutes value.
 * "7890" → "5 days" instead of "7890m".
 */
export function formatWaitingDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainMin = Math.round(minutes % 60);
  if (hours < 24) {
    return remainMin > 0 ? `${hours} hr ${remainMin} min` : `${hours} hr`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 14) return 'over a week';
  return `${Math.floor(days / 7)} weeks`;
}

/**
 * Duration with urgency tone for visual styling.
 * < 1 hr = normal, 1-24 hr = attention (amber), 24hr+ = urgent (red).
 */
export function formatDurationWithUrgency(minutes: number): { text: string; tone: UrgencyTone } {
  const text = formatWaitingDuration(minutes);
  if (!Number.isFinite(minutes) || minutes < 60) return { text, tone: 'normal' };
  if (minutes < 1440) return { text, tone: 'attention' };
  return { text, tone: 'urgent' };
}

export function formatAbsoluteTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function formatRelativeTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const diffMs = date.getTime() - Date.now();
  if (Number.isNaN(diffMs)) return 'unknown';

  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const direction = diffMs < 0 ? 'past' : 'future';

  if (absSeconds < 10) return direction === 'past' ? 'just now' : 'soon';
  if (absSeconds < 60) return direction === 'past' ? `${absSeconds}s ago` : `in ${absSeconds}s`;

  const minutes = Math.floor(absSeconds / 60);
  if (minutes < 60) return direction === 'past' ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return direction === 'past' ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.floor(hours / 24);
  return direction === 'past' ? `${days}d ago` : `in ${days}d`;
}
