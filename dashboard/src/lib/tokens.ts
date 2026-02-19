export const colors = {
  // OrgX brand system (aligned with useorgx.com + mcp.useorgx.com)
  lime: '#BFFF00',
  teal: '#14B8A6',
  cyan: '#0AD4C4',
  iris: '#7C7CFF',

  amber: '#F5B700',
  red: '#FF6B88',

  background: '#02040A',
  cardBg: '#08090D',
  cardBgElevated: '#0C0E14',
  cardBorder: 'rgba(255, 255, 255, 0.08)',
  cardBorderStrong: 'rgba(255, 255, 255, 0.12)',

  text: '#F2F7FF',
  textMuted: '#8F9AB7',
} as const;

export const agentColors: Record<string, string> = {
  Pace: '#7C7CFF',
  Eli: '#BFFF00',
  Dana: '#FF00D4',
  Mark: '#F5B700',
  System: '#14B8A6',
  Sage: '#0AD4C4',
  Orion: '#14B8A6',
  Xandy: '#FF6B88',
  Nova: '#A78BFA',
};

export const agentRoles: Record<string, string> = {
  Pace: 'Engineering',
  Eli: 'Engineering',
  Dana: 'Product Design',
  Mark: 'Marketing',
  System: 'System',
  Sage: 'Strategy',
  Orion: 'Operations',
  Xandy: 'Orchestrator',
  Nova: 'Research',
};

export function getAgentColor(name: string): string {
  return agentColors[name] ?? 'rgba(255, 255, 255, 0.4)';
}

export function getAgentRole(name: string): string | null {
  return agentRoles[name] ?? null;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// ── Motion tokens ────────────────────────────────────────────────
// Single source of truth for animation timing across all components.

export const motion = {
  durationInstant: 100,
  durationFast: 150,
  durationStandard: 220,
  durationEntrance: 360,
  durationSlow: 600,
  easingStandard: [0.22, 1, 0.36, 1] as const,
  easingEntrance: [0.16, 1, 0.3, 1] as const,
  easingSpring: { type: 'spring' as const, stiffness: 400, damping: 35 },
  easingBounce: { type: 'spring' as const, stiffness: 320, damping: 28, mass: 0.7 },
} as const;

/** Standard whileTap for all action buttons. */
export const buttonTap = { whileTap: { scale: 0.97 }, transition: { duration: 0.1 } };

/** Subtle hover lift for primary action buttons. */
export const buttonHover = { whileHover: { scale: 1.01 } };

/** Stagger entrance for list items. */
export const listItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: Math.min(i, 8) * 0.04,
      duration: motion.durationStandard / 1000,
      ease: motion.easingStandard as unknown as number[],
    },
  }),
};

/** Cross-fade transition for tab/filter content switching. */
export const tabCrossFade = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.15 },
};

/** Popover/overflow menu animation. */
export const popoverAnimation = {
  initial: { opacity: 0, scale: 0.95, y: 4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 4 },
  transition: { duration: 0.15, ease: motion.easingStandard as unknown as number[] },
};
