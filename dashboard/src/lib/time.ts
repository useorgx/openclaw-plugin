export function formatRelativeTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const diffMs = Date.now() - date.getTime();
  if (Number.isNaN(diffMs)) return 'unknown';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
