export const ACTIVITY_TIME_FILTERS = [
  { id: 'live', label: 'Live', minutes: null },
  { id: 'all', label: 'All', minutes: null },
  { id: '24h', label: '24h', minutes: 24 * 60 },
  { id: '3d', label: '3d', minutes: 3 * 24 * 60 },
  { id: '7d', label: '7d', minutes: 7 * 24 * 60 },
  { id: '30d', label: '30d', minutes: 30 * 24 * 60 },
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

