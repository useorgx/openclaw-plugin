export const ACTIVITY_TIME_FILTERS = [
  { id: 'live', label: 'Last hour', minutes: null },
  { id: '24h', label: 'Today', minutes: null },
  { id: '7d', label: 'This week', minutes: 7 * 24 * 60 },
  { id: 'custom', label: 'Custom', minutes: null },
  { id: 'all', label: 'All', minutes: null },
] as const;

export type ActivityTimeFilterId = (typeof ACTIVITY_TIME_FILTERS)[number]['id'];

export function resolveActivityTimeFilter(id: string | null | undefined) {
  return ACTIVITY_TIME_FILTERS.find((entry) => entry.id === id) ?? ACTIVITY_TIME_FILTERS[0];
}

export function cutoffEpochForActivityFilter(
  id: ActivityTimeFilterId,
  nowEpoch = Date.now()
): number | null {
  if (id === 'all') return null;
  if (id === 'live') {
    // "Live" means "recent enough to feel current" for activity queries.
    return nowEpoch - 60 * 60_000;
  }
  if (id === '24h') {
    // "Today" means current local calendar day (midnight -> now), not a rolling 24h window.
    const now = new Date(nowEpoch);
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  }
  if (id === 'custom') {
    // Callers provide explicit since/until for custom ranges.
    return null;
  }
  const entry = ACTIVITY_TIME_FILTERS.find((e) => e.id === id);
  if (!entry || entry.minutes === null) return null;
  return nowEpoch - entry.minutes * 60_000;
}

export function sinceIsoForActivityFilter(
  id: ActivityTimeFilterId,
  nowEpoch = Date.now()
): string | null {
  const cutoff = cutoffEpochForActivityFilter(id, nowEpoch);
  if (!cutoff) return null;
  return new Date(cutoff).toISOString();
}
