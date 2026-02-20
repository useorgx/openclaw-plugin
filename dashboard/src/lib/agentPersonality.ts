export interface AgentPersonality {
  domain: string;
  displayName: string;
  gradient: [string, string];
  accentColor: string;
  glowColor: string;
  icon: string;
  progressStyle: 'linear' | 'stepped' | 'wave';
  verb: string;
}

export const AGENT_PERSONALITIES: Record<string, AgentPersonality> = {
  engineering: {
    domain: 'engineering',
    displayName: 'Engineering',
    gradient: ['#22c55e', '#14b8a6'],
    accentColor: '#22c55e',
    glowColor: '#22c55e33',
    icon: 'hammer',
    progressStyle: 'linear',
    verb: 'Building',
  },
  design: {
    domain: 'design',
    displayName: 'Design',
    gradient: ['#a78bfa', '#ec4899'],
    accentColor: '#a78bfa',
    glowColor: '#a78bfa33',
    icon: 'palette',
    progressStyle: 'wave',
    verb: 'Designing',
  },
  product: {
    domain: 'product',
    displayName: 'Product',
    gradient: ['#3b82f6', '#6366f1'],
    accentColor: '#3b82f6',
    glowColor: '#3b82f633',
    icon: 'compass',
    progressStyle: 'stepped',
    verb: 'Specifying',
  },
  marketing: {
    domain: 'marketing',
    displayName: 'Marketing',
    gradient: ['#f59e0b', '#ef4444'],
    accentColor: '#f59e0b',
    glowColor: '#f59e0b33',
    icon: 'megaphone',
    progressStyle: 'wave',
    verb: 'Crafting',
  },
  sales: {
    domain: 'sales',
    displayName: 'Sales',
    gradient: ['#06b6d4', '#3b82f6'],
    accentColor: '#06b6d4',
    glowColor: '#06b6d433',
    icon: 'handshake',
    progressStyle: 'linear',
    verb: 'Preparing',
  },
  operations: {
    domain: 'operations',
    displayName: 'Operations',
    gradient: ['#64748b', '#475569'],
    accentColor: '#64748b',
    glowColor: '#64748b33',
    icon: 'shield',
    progressStyle: 'stepped',
    verb: 'Securing',
  },
  orchestrator: {
    domain: 'orchestrator',
    displayName: 'Orchestrator',
    gradient: ['#8b5cf6', '#6366f1'],
    accentColor: '#8b5cf6',
    glowColor: '#8b5cf633',
    icon: 'workflow',
    progressStyle: 'linear',
    verb: 'Coordinating',
  },
};

const KNOWN_DOMAINS = Object.keys(AGENT_PERSONALITIES);

/** Infer agent domain from agentId string (e.g. "engineering-bot" → "engineering"). */
export function inferAgentDomain(agentId: string | null | undefined): string {
  if (!agentId) return 'engineering';
  const normalized = agentId.trim().toLowerCase();
  for (const domain of KNOWN_DOMAINS) {
    if (normalized.includes(domain)) return domain;
  }
  return 'engineering';
}

export function getAgentPersonality(domain: string): AgentPersonality {
  return AGENT_PERSONALITIES[domain] ?? AGENT_PERSONALITIES.engineering;
}
