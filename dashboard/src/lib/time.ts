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
