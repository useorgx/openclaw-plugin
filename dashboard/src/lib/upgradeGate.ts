export type UpgradeActions = {
  checkout?: string;
  portal?: string;
  pricing?: string;
};

export type UpgradeGatePayload = {
  ok?: boolean;
  code?: string;
  error?: string;
  currentPlan?: string;
  requiredPlan?: string;
  actions?: UpgradeActions;
};

export class UpgradeRequiredError extends Error {
  readonly code = 'upgrade_required' as const;
  readonly currentPlan: string | null;
  readonly requiredPlan: string;
  readonly actions: UpgradeActions | null;

  constructor(
    message: string,
    input?: {
      currentPlan?: string | null;
      requiredPlan?: string | null;
      actions?: UpgradeActions | null;
    }
  ) {
    super(message);
    this.name = 'UpgradeRequiredError';
    this.currentPlan = input?.currentPlan ?? null;
    this.requiredPlan = (input?.requiredPlan ?? 'starter').trim() || 'starter';
    this.actions = input?.actions ?? null;
  }
}

export function parseUpgradeRequiredError(
  payload: unknown
): UpgradeRequiredError | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as UpgradeGatePayload;
  if (raw.code !== 'upgrade_required') return null;

  const message =
    typeof raw.error === 'string' && raw.error.trim()
      ? raw.error.trim()
      : 'Upgrade required.';

  return new UpgradeRequiredError(message, {
    currentPlan:
      typeof raw.currentPlan === 'string' && raw.currentPlan.trim()
        ? raw.currentPlan.trim()
        : null,
    requiredPlan:
      typeof raw.requiredPlan === 'string' && raw.requiredPlan.trim()
        ? raw.requiredPlan.trim()
        : null,
    actions: raw.actions ?? null,
  });
}

export function formatPlanLabel(plan: string | null | undefined): string {
  const normalized = (plan ?? '').trim().toLowerCase();
  if (!normalized) return 'Unknown';
  if (normalized === 'free') return 'Free';
  if (normalized === 'starter') return 'Starter';
  if (normalized === 'team') return 'Team';
  if (normalized === 'enterprise') return 'Enterprise';
  return normalized[0].toUpperCase() + normalized.slice(1);
}

