import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { InferredAgent } from '@/hooks/useAgentEntityMap';

// ── OrgX Agent Persona Resolution ────────────────────────────────
// Maps system identifiers to branded OrgX persona names and colors.

export const agentPersonaColors: Record<string, string> = {
  Pace: '#7C7CFF',
  Eli: '#BFFF00',
  Dana: '#FF00D4',
  Mark: '#F5B700',
  Sage: '#0AD4C4',
  Orion: '#14B8A6',
  Xandy: '#FF6B88',
  Nova: '#A78BFA',
};

export const agentPersonaDomains: Record<string, string> = {
  Eli: 'Engineering',
  Pace: 'Product',
  Dana: 'Design',
  Mark: 'Marketing',
  Sage: 'Strategy',
  Orion: 'Operations',
  Xandy: 'Orchestrator',
  Nova: 'Research',
};

/** Reverse: domain keyword to persona name. */
const domainToPersona: Record<string, string> = {
  engineering: 'Eli',
  product: 'Pace',
  design: 'Dana',
  marketing: 'Mark',
  strategy: 'Strategy',
  sales: 'Sage',
  operations: 'Orion',
  orchestrator: 'Xandy',
  research: 'Nova',
};

/** System-level agent identifiers that map to OrgX personas. */
const agentIdToPersona: Record<string, string> = {
  eli: 'Eli',
  pace: 'Pace',
  dana: 'Dana',
  mark: 'Mark',
  sage: 'Sage',
  orion: 'Orion',
  xandy: 'Xandy',
  nova: 'Nova',
  'engineering-agent': 'Eli',
  'product-agent': 'Pace',
  'design-agent': 'Dana',
  'marketing-agent': 'Mark',
  'strategy-agent': 'Sage',
  'sales-agent': 'Sage',
  'operations-agent': 'Orion',
  'orchestrator-agent': 'Xandy',
  'research-agent': 'Nova',
  'engineering-bot': 'Eli',
  'product-bot': 'Pace',
  'design-bot': 'Dana',
  'marketing-bot': 'Mark',
  'dev-delivery': 'Eli',
  'launch-captain': 'Mark',
  'pipeline-intelligence': 'Sage',
  'control-tower': 'Orion',
  'design-codex': 'Dana',
  'router-all-agents': 'Xandy',
  'ops-orbit': 'Orion',
  'sales-sage': 'Sage',
};

export interface ResolvedAgentPersona {
  name: string;
  domain: string;
  color: string;
  displayLabel: string; // e.g. "Eli (Engineering)"
}

/**
 * Resolve an agent identifier (name, agentId, or agentName) into a
 * branded OrgX persona with color and domain label.
 */
export function resolveAgentPersona(
  agentId: string | null | undefined,
  agentName?: string | null
): ResolvedAgentPersona {
  const fallback: ResolvedAgentPersona = {
    name: agentName?.trim() || 'OrgX',
    domain: '',
    color: 'rgba(255,255,255,0.4)',
    displayLabel: agentName?.trim() || 'OrgX',
  };

  // Try exact match on agentId first
  if (agentId) {
    const normalized = agentId.trim().toLowerCase();
    const personaFromId = agentIdToPersona[normalized];
    if (personaFromId) {
      const domain = agentPersonaDomains[personaFromId] ?? '';
      return {
        name: personaFromId,
        domain,
        color: agentPersonaColors[personaFromId] ?? fallback.color,
        displayLabel: domain ? `${personaFromId} (${domain})` : personaFromId,
      };
    }

    // Try domain keyword match inside agentId
    for (const [keyword, persona] of Object.entries(domainToPersona)) {
      if (normalized.includes(keyword)) {
        const domain = agentPersonaDomains[persona] ?? '';
        return {
          name: persona,
          domain,
          color: agentPersonaColors[persona] ?? fallback.color,
          displayLabel: domain ? `${persona} (${domain})` : persona,
        };
      }
    }
  }

  // Try matching on agentName
  if (agentName) {
    const normalizedName = agentName.trim();
    // Direct persona name match (e.g. "Eli", "Pace")
    if (agentPersonaColors[normalizedName]) {
      const domain = agentPersonaDomains[normalizedName] ?? '';
      return {
        name: normalizedName,
        domain,
        color: agentPersonaColors[normalizedName],
        displayLabel: domain ? `${normalizedName} (${domain})` : normalizedName,
      };
    }

    // Lowercase check in agentIdToPersona
    const lowerName = normalizedName.toLowerCase();
    const personaFromName = agentIdToPersona[lowerName];
    if (personaFromName) {
      const domain = agentPersonaDomains[personaFromName] ?? '';
      return {
        name: personaFromName,
        domain,
        color: agentPersonaColors[personaFromName] ?? fallback.color,
        displayLabel: domain ? `${personaFromName} (${domain})` : personaFromName,
      };
    }

    // Domain keyword match
    for (const [keyword, persona] of Object.entries(domainToPersona)) {
      if (lowerName.includes(keyword)) {
        const domain = agentPersonaDomains[persona] ?? '';
        return {
          name: persona,
          domain,
          color: agentPersonaColors[persona] ?? fallback.color,
          displayLabel: domain ? `${persona} (${domain})` : persona,
        };
      }
    }
  }

  return fallback;
}

// ── Agent Persona Badge ──────────────────────────────────────────
// Renders "Eli (Engineering)" with colored avatar circle.

interface AgentPersonaBadgeProps {
  agentId: string | null | undefined;
  agentName?: string | null;
  isActive?: boolean;
  size?: 'sm' | 'md';
}

export function AgentPersonaBadge({
  agentId,
  agentName,
  isActive = false,
  size = 'sm',
}: AgentPersonaBadgeProps) {
  const persona = resolveAgentPersona(agentId, agentName);
  const avatarSize = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 text-[11px]';

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div
        className={`${avatarSize} rounded-full flex items-center justify-center font-bold flex-shrink-0 ${
          isActive ? 'status-breathe' : ''
        }`}
        style={{
          backgroundColor: `${persona.color}20`,
          color: persona.color,
          boxShadow: isActive ? `0 0 8px ${persona.color}40` : undefined,
        }}
      >
        {persona.name.charAt(0).toUpperCase()}
      </div>
      <span
        className="text-[13px] font-semibold truncate"
        style={{ color: persona.color }}
      >
        {persona.displayLabel}
      </span>
    </div>
  );
}

// ── Inferred Agent Avatars (original) ────────────────────────────

interface InferredAgentAvatarsProps {
  agents: InferredAgent[];
  max?: number;
}

export function InferredAgentAvatars({ agents, max = 4 }: InferredAgentAvatarsProps) {
  if (!agents.length) return null;

  const shown = agents.slice(0, max);
  const overflow = agents.length - max;

  return (
    <div className="inline-flex min-w-0 items-center justify-end -space-x-1.5 pl-1">
      {shown.map((agent) => (
        <div
          key={agent.id}
          className="relative flex-shrink-0"
          title={`${agent.name} (${agent.confidence} confidence)`}
          style={{
            borderRadius: '9999px',
            border:
              agent.confidence === 'high'
                ? '1.5px solid rgba(255,255,255,0.25)'
                : agent.confidence === 'medium'
                  ? '1.5px dashed rgba(255,255,255,0.15)'
                  : '1.5px dotted rgba(255,255,255,0.10)',
          }}
        >
          <AgentAvatar name={agent.name} size="xs" />
        </div>
      ))}
      {overflow > 0 && (
        <span className="ml-1 flex-shrink-0 text-micro text-muted">+{overflow}</span>
      )}
    </div>
  );
}
