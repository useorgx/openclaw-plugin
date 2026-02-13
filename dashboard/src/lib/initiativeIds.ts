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

function isDemoModeEnabled(): boolean {
  // Demo mode is a purely client-side concern; avoid introducing hard dependencies
  // on browser globals for SSR/build-time evaluation.
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') return true;
  } catch {
    // ignore
  }
  try {
    // Keep in sync with dashboard/src/App.tsx
    return window.localStorage.getItem('orgx.demo_mode') === '1';
  } catch {
    return false;
  }
}

export function canQueryInitiativeEntities(
  initiativeId: string | null | undefined
): boolean {
  // In demo mode we intentionally allow querying synthetic IDs (e.g. init-1) so
  // Playwright QA capture and local demo harnesses can route/fulfill the requests.
  if (isDemoModeEnabled()) return true;
  return !isSyntheticInitiativeId(initiativeId);
}
