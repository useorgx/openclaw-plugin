import type { UpgradeActions } from '@/lib/upgradeGate';

type BillingUrlResponse =
  | { ok?: boolean; data?: { url?: string | null }; url?: string | null; error?: string }
  | null;

async function resolveBillingUrl(
  endpoint: string,
  init: RequestInit
): Promise<string> {
  const response = await fetch(endpoint, init);
  const payload = (await response.json().catch(() => null)) as BillingUrlResponse;
  const url = payload?.data?.url ?? (payload as any)?.url ?? null;
  if (typeof url === 'string' && url.trim()) return url.trim();
  throw new Error(payload?.error ?? 'Billing link unavailable');
}

export async function openUpgradeCheckout(input?: {
  actions?: UpgradeActions | null;
  requiredPlan?: string | null;
}): Promise<void> {
  const checkoutPath = input?.actions?.checkout ?? '/orgx/api/billing/checkout';
  const requiredPlan = (input?.requiredPlan ?? 'starter').trim().toLowerCase() || 'starter';
  const url = await resolveBillingUrl(checkoutPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: requiredPlan }),
  });
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openBillingPortal(input?: {
  actions?: UpgradeActions | null;
}): Promise<void> {
  const portalPath = input?.actions?.portal ?? '/orgx/api/billing/portal';
  const url = await resolveBillingUrl(portalPath, { method: 'POST' });
  window.open(url, '_blank', 'noopener,noreferrer');
}

