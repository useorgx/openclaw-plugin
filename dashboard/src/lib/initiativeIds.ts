const SYNTHETIC_INITIATIVE_IDS = new Set([
  'ungrouped',
  'unscoped',
  'unknown',
]);

export function isSyntheticInitiativeId(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  if (SYNTHETIC_INITIATIVE_IDS.has(normalized)) return true;
  if (/^init-\d+$/.test(normalized)) return true;
  if (normalized.startsWith('mock-')) return true;
  return false;
}

export function canQueryInitiativeEntities(
  initiativeId: string | null | undefined
): boolean {
  return !isSyntheticInitiativeId(initiativeId);
}
