import { OxStateChip } from '@useorgx/orgx-ui-kit/react';
import { toKitState, type KitStatus } from '@/lib/agentIdentity';
import { normalizeStatus } from '@/lib/tokens';

/** Every state an entity row can show, so the chip keeps one width as status moves. */
const ENTITY_CHIP_RESERVE = 'running queued needs_you blocked failed_step succeeded cancelled';

interface StatusChipProps {
  /** Any dashboard status spelling (active, in_progress, blocked, done, ...). */
  status: string | null | undefined;
  detail?: string;
  className?: string;
  /** Wording override; the tone still comes from the status. */
  label?: string;
  /**
   * "entity" (default): initiatives, workstreams, milestones and tasks, where
   * "active" means open. "run": sessions and slices, where "active" means running.
   */
  kind?: 'entity' | 'run';
  /** Reserve the width of every entity state (default) so rows never reflow. */
  reserve?: boolean;
}

/**
 * The OrgX kit's <ox-state-chip> for a dashboard status: one pill, kit wording
 * and tone (amber needs you, teal moving or done, red failed, mute out of your
 * hands). Replaces the hand-rolled uppercase status pills.
 */
export function StatusChip({ status, detail, className, label, kind = 'entity', reserve = true }: StatusChipProps) {
  const kit = kind === 'run' ? toKitState(status) : entityKitState(status);
  return (
    <OxStateChip
      className={className}
      state={kit.state}
      label={label ?? kit.label}
      detail={detail}
      reserve={reserve ? ENTITY_CHIP_RESERVE : undefined}
    />
  );
}

/**
 * Entities (initiatives, workstreams, milestones, tasks) say "active" when they
 * are open, not necessarily executing, so they read "Active" on a quiet teal
 * dot rather than "Running"; "at risk" is amber.
 */
function entityKitState(status: string | null | undefined): KitStatus {
  const normalized = normalizeStatus(status ?? '');
  if (normalized === 'active') return { state: 'committed', label: 'Active' };
  if (normalized === 'at_risk') return { state: 'stale', label: 'At risk' };
  return toKitState(status);
}
