import type { ActionState, AgentKey, AvatarForm } from '@useorgx/orgx-ui-kit/react';
import { normalizeStatus } from '@/lib/tokens';

/**
 * Agent identity and run-state mapping for the OrgX design kit elements.
 *
 * resolveAgentKey / formForState are ported from the MCP widgets'
 * shared/agent-identity.js so the dashboard picks the same agent and the same
 * avatar form as the widgets do. toKitState maps the dashboard's many run and
 * session status spellings onto the kit's canonical action states, which
 * <ox-state-chip> renders with the shared wording and tone (amber needs you,
 * teal moving or done, red failed and retryable, mute out of your hands).
 */

const AGENT_WORDS: Array<{ key: AgentKey; words: string[] }> = [
  { key: 'pace', words: ['pace', 'product', 'product-agent', 'product_orchestrator'] },
  { key: 'eli', words: ['eli', 'engineering', 'engineering-agent', 'engineering_autopilot'] },
  { key: 'mark', words: ['mark', 'marketing', 'marketing-agent', 'launch_captain'] },
  { key: 'sage', words: ['sage', 'sales', 'sales-agent', 'pipeline_intelligence'] },
  { key: 'orion', words: ['orion', 'operations', 'ops', 'operations-agent', 'control_tower'] },
  { key: 'dana', words: ['dana', 'design', 'design-agent', 'design_codex'] },
  { key: 'xandy', words: ['xandy', 'orchestrator', 'orchestrator-agent', 'xandy_orchestrator'] },
];

/**
 * Map an agent name, id or domain to one of the seven OrgX agent keys.
 * Whole words only, so "Developer" or "Scope" never resolve by accident.
 * Returns null for people, providers, system actors and unknown owners.
 */
export function resolveAgentKey(...values: Array<string | null | undefined>): AgentKey | null {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const tokens = value.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
    for (const agent of AGENT_WORDS) {
      if (tokens.some((token) => agent.words.includes(token))) return agent.key;
    }
  }
  return null;
}

/** Avatar form for a kit state: asking needs the person, working runs, verifying checks proof. */
export function formForState(state: ActionState | string | null | undefined): AvatarForm {
  switch (state) {
    case 'needs_you':
    case 'held':
    case 'paused_for_input':
      return 'asking';
    case 'running':
    case 'queued':
    case 'sending':
      return 'working';
    case 'verifying':
      return 'verifying';
    case 'succeeded':
    case 'confirmed':
      return 'proactive';
    default:
      return 'base';
  }
}

export interface KitStatus {
  state: ActionState;
  /** Wording override where the kit has no canonical word for the dashboard state. */
  label?: string;
}

/**
 * Dashboard run / session / slice status -> kit action state.
 * Unknown values fall back to a quiet, muted chip so nothing renders loud by accident.
 */
export function toKitState(raw: string | null | undefined): KitStatus {
  const status = normalizeStatus(raw ?? '');
  switch (status) {
    case 'running':
    case 'active':
    case 'in_progress':
    case 'working':
    case 'planning':
    case 'dispatched':
    case 'handoff':
    case 'launching':
    case 'dispatching':
      return { state: 'running' };
    case 'review':
    case 'reviewing':
    case 'verifying':
    case 'checking':
      return { state: 'verifying' };
    case 'queued':
    case 'pending':
    case 'scheduled':
    case 'todo':
    case 'planned':
    case 'ready':
      return { state: 'queued' };
    case 'needs_input':
    case 'needs_review':
    case 'needs_you':
    case 'needs_attention':
    case 'awaiting_input':
    case 'waiting_for_input':
    case 'waiting':
    case 'decision_needed':
      return { state: 'needs_you' };
    case 'blocked':
      return { state: 'blocked' };
    case 'failed':
    case 'error':
    case 'errored':
    case 'run_failed':
      return { state: 'failed_step' };
    case 'retrying':
      return { state: 'retrying' };
    case 'completed':
    case 'complete':
    case 'done':
    case 'succeeded':
    case 'success':
    case 'resolved':
      return { state: 'succeeded' };
    case 'partial':
    case 'partially_succeeded':
      return { state: 'partially_succeeded' };
    case 'cancelled':
    case 'canceled':
      return { state: 'cancelled' };
    case 'paused':
    case 'stopped':
      return { state: 'cancelled', label: 'Paused' };
    case 'stale':
      return { state: 'stale' };
    case 'offline':
    case 'disconnected':
      return { state: 'offline' };
    default:
      return { state: 'cancelled', label: status ? humanize(status) : 'Idle' };
  }
}

function humanize(status: string): string {
  const words = status.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The states a session row can show, so <ox-state-chip reserve> keeps one
 * width as a row moves between them (no reflow on state change).
 */
export const SESSION_CHIP_RESERVE =
  'running verifying queued needs_you blocked failed_step retrying succeeded cancelled';
