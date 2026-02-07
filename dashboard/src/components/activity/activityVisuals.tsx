import { colors } from '@/lib/tokens';
import type { LiveActivityItem, LiveActivityType } from '@/types';

export type ActivityIconName =
  | 'play'
  | 'check_circle'
  | 'alert_triangle'
  | 'file'
  | 'file_code'
  | 'git_commit'
  | 'shield'
  | 'shield_check'
  | 'shield_x'
  | 'handoff'
  | 'handoff_claimed'
  | 'sparkles'
  | 'octagon_x'
  | 'flag'
  | 'workflow'
  | 'memory_sync'
  | 'heartbeat'
  | 'checkpoint'
  | 'quality_gate'
  | 'route'
  | 'terminal'
  | 'compass'
  | 'message';

export interface ActivityVisual {
  icon: ActivityIconName;
  label: string;
  color: string;
}

type Meta = Record<string, unknown> | undefined;

const BASE_TYPE_VISUAL: Record<LiveActivityType, ActivityVisual> = {
  run_started: { icon: 'play', label: 'Run started', color: colors.teal },
  run_completed: { icon: 'check_circle', label: 'Run completed', color: colors.lime },
  run_failed: { icon: 'alert_triangle', label: 'Run failed', color: colors.red },
  artifact_created: { icon: 'file', label: 'Artifact', color: colors.cyan },
  decision_requested: { icon: 'shield', label: 'Decision requested', color: colors.amber },
  decision_resolved: { icon: 'shield_check', label: 'Decision resolved', color: colors.lime },
  handoff_requested: { icon: 'handoff', label: 'Handoff requested', color: colors.iris },
  handoff_claimed: { icon: 'handoff_claimed', label: 'Handoff claimed', color: colors.teal },
  handoff_fulfilled: { icon: 'sparkles', label: 'Handoff fulfilled', color: colors.lime },
  blocker_created: { icon: 'octagon_x', label: 'Blocker', color: colors.red },
  milestone_completed: { icon: 'flag', label: 'Milestone', color: colors.cyan },
  delegation: { icon: 'workflow', label: 'Delegation', color: colors.iris },
};

function readMetaString(meta: Meta, keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase();
}

function textHaystack(item: LiveActivityItem, meta: Meta): string {
  return [
    item.type,
    item.kind,
    item.phase,
    item.state,
    item.title,
    item.summary,
    item.description,
    readMetaString(meta, ['source', 'event', 'eventType', 'artifact_type', 'action', 'kind']),
    readMetaString(meta, ['task', 'taskName', 'workstream', 'milestone', 'status']),
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function artifactVisual(meta: Meta, haystack: string): ActivityVisual {
  const artifactType = normalizeText(readMetaString(meta, ['artifact_type', 'artifactType']));
  if (artifactType.includes('pr') || /pull request|merge request/.test(haystack)) {
    return { icon: 'file_code', label: 'Pull request', color: colors.cyan };
  }
  if (artifactType.includes('commit') || /commit|diff|patch/.test(haystack)) {
    return { icon: 'git_commit', label: 'Commit', color: colors.cyan };
  }
  if (artifactType.includes('config')) {
    return { icon: 'checkpoint', label: 'Config', color: colors.cyan };
  }
  if (artifactType.includes('design')) {
    return { icon: 'compass', label: 'Design output', color: colors.cyan };
  }
  if (artifactType.includes('report') || artifactType.includes('document') || /memo|doc/.test(haystack)) {
    return { icon: 'file', label: 'Document', color: colors.cyan };
  }
  return BASE_TYPE_VISUAL.artifact_created;
}

/**
 * Core activity icon taxonomy.
 * Covers run lifecycle, handoffs, decisions, artifacts, and architecture signals
 * such as heartbeat, memory/sync, checkpoints, quality gates, and routing.
 */
export function resolveActivityVisual(item: LiveActivityItem): ActivityVisual {
  const meta = item.metadata as Meta;
  const haystack = textHaystack(item, meta);
  const source = normalizeText(readMetaString(meta, ['source']));
  const action = normalizeText(readMetaString(meta, ['action']));

  if (/heartbeat|heart beat|alive signal/.test(haystack)) {
    return { icon: 'heartbeat', label: 'Heartbeat', color: colors.teal };
  }

  if (/soul/.test(haystack)) {
    return { icon: 'compass', label: 'Soul state', color: colors.iris };
  }

  if (/memory sync|sync memory|workspace state|sync completed|memory file/.test(haystack)) {
    return { icon: 'memory_sync', label: 'Memory sync', color: colors.teal };
  }

  if (/checkpoint|rollback|restore point/.test(haystack)) {
    return { icon: 'checkpoint', label: 'Checkpoint', color: colors.amber };
  }

  if (/quality gate|quality score|quality check/.test(haystack)) {
    return { icon: 'quality_gate', label: 'Quality gate', color: colors.lime };
  }

  if (/model routing|routed model|model tier/.test(haystack)) {
    return { icon: 'route', label: 'Model routing', color: colors.iris };
  }

  if (source === 'local_openclaw') {
    return { icon: 'terminal', label: 'Local OpenClaw', color: colors.teal };
  }

  if (item.type === 'artifact_created') {
    return artifactVisual(meta, haystack);
  }

  if (item.type === 'decision_resolved') {
    if (action === 'reject' || /rejected|declined/.test(haystack)) {
      return { icon: 'shield_x', label: 'Decision rejected', color: colors.red };
    }
    return { icon: 'shield_check', label: 'Decision approved', color: colors.lime };
  }

  if (item.type === 'delegation') {
    if (/dispatch|spawn|launched|kickoff|started/.test(haystack)) {
      return { icon: 'workflow', label: 'Dispatch', color: colors.iris };
    }
    if (/message|chat|reply|summary/.test(haystack)) {
      return { icon: 'message', label: 'Message', color: colors.teal };
    }
  }

  return BASE_TYPE_VISUAL[item.type] ?? { icon: 'message', label: 'Activity', color: colors.textMuted };
}

export function ActivityEventIcon({
  icon,
  size = 14,
  className,
}: {
  icon: ActivityIconName;
  size?: number;
  className?: string;
}) {
  const commonProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };

  switch (icon) {
    case 'play':
      return <svg {...commonProps}><path d="m8 6 10 6-10 6z" /></svg>;
    case 'check_circle':
      return <svg {...commonProps}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>;
    case 'alert_triangle':
      return <svg {...commonProps}><path d="m12 3 9 16H3z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
    case 'file':
      return <svg {...commonProps}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /></svg>;
    case 'file_code':
      return <svg {...commonProps}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /><path d="m10 13-2 2 2 2" /><path d="m14 13 2 2-2 2" /></svg>;
    case 'git_commit':
      return <svg {...commonProps}><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></svg>;
    case 'shield':
      return <svg {...commonProps}><path d="M12 3 5 6v6c0 5 3.3 7.8 7 9 3.7-1.2 7-4 7-9V6z" /><path d="M12 9v4" /><path d="M12 16h.01" /></svg>;
    case 'shield_check':
      return <svg {...commonProps}><path d="M12 3 5 6v6c0 5 3.3 7.8 7 9 3.7-1.2 7-4 7-9V6z" /><path d="m9 12.5 2 2 4-4" /></svg>;
    case 'shield_x':
      return <svg {...commonProps}><path d="M12 3 5 6v6c0 5 3.3 7.8 7 9 3.7-1.2 7-4 7-9V6z" /><path d="m10 10 4 4M14 10l-4 4" /></svg>;
    case 'handoff':
      return <svg {...commonProps}><path d="M7 8h6a3 3 0 1 1 0 6H8" /><path d="m10 14-3 3-3-3" /><path d="M17 10h-4" /></svg>;
    case 'handoff_claimed':
      return <svg {...commonProps}><path d="M8.5 12.5 12 9l3.5 3.5" /><path d="M6 14h12" /><path d="M7 18h10" /></svg>;
    case 'sparkles':
      return <svg {...commonProps}><path d="m12 3 1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5z" /><path d="m5 14 .8 1.8L8 16.6l-2.2.8L5 19l-.8-1.6L2 16.6l2.2-.8z" /><path d="m19 14 .8 1.8 2.2.8-2.2.8L19 19l-.8-1.6-2.2-.8 2.2-.8z" /></svg>;
    case 'octagon_x':
      return <svg {...commonProps}><path d="m10.2 3-5.8 3.3v11.4L10.2 21h3.6l5.8-3.3V6.3L13.8 3z" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
    case 'flag':
      return <svg {...commonProps}><path d="M5 3v18" /><path d="m5 4 12 1-2 4 2 4-12-1" /></svg>;
    case 'workflow':
      return <svg {...commonProps}><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M6.5 7.5 11 16M17.5 7.5 13 16" /></svg>;
    case 'memory_sync':
      return <svg {...commonProps}><ellipse cx="12" cy="5.5" rx="6.5" ry="2.5" /><path d="M5.5 5.5v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-6" /><path d="m8 17-2 2 2 2" /><path d="M16 17l2 2-2 2" /></svg>;
    case 'heartbeat':
      return <svg {...commonProps}><path d="M3 12h4l2-4 3 8 2-4h7" /></svg>;
    case 'checkpoint':
      return <svg {...commonProps}><path d="M12 3v6" /><path d="M8 5h8" /><path d="M7 11h10v10H7z" /><path d="M9 14h6" /></svg>;
    case 'quality_gate':
      return <svg {...commonProps}><path d="M12 3 5 6v6c0 5 3.3 7.8 7 9 3.7-1.2 7-4 7-9V6z" /><path d="m9 12.5 2 2 4-4" /></svg>;
    case 'route':
      return <svg {...commonProps}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h4a4 4 0 0 1 4 4v6" /><path d="M16 6h2" /></svg>;
    case 'terminal':
      return <svg {...commonProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></svg>;
    case 'compass':
      return <svg {...commonProps}><circle cx="12" cy="12" r="9" /><path d="m10 10 6-2-2 6-6 2z" /></svg>;
    case 'message':
    default:
      return <svg {...commonProps}><path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.5-4A8 8 0 1 1 21 12z" /></svg>;
  }
}
