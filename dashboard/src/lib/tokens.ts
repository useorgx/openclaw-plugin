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

// ── Foundational scales ──────────────────────────────────────────
// Explicit foundation exports keep Figma/MCP automation aligned with
// the production dashboard instead of deriving values ad-hoc from classes.

export const spacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  14: 56,
  16: 64,
} as const;

export const radius = {
  none: 0,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  shell: 14,
  controlPill: 10,
  mobileTab: 18,
  mobileNav: 24,
  full: 999,
} as const;

export const typography = {
  fontFamily: {
    sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
    mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  size: {
    micro: { fontSize: 10, lineHeight: 14, letterSpacing: 0.05 },
    caption: { fontSize: 11, lineHeight: 16, letterSpacing: 0.03 },
    body: { fontSize: 13, lineHeight: 20, letterSpacing: 0 },
    heading: { fontSize: 15, lineHeight: 22, letterSpacing: -0.01 },
    title: { fontSize: 20, lineHeight: 28, letterSpacing: -0.015 },
  },
} as const;

export const border = {
  width: {
    hairline: 1,
    focus: 2,
  },
  color: {
    subtle: 'rgba(255, 255, 255, 0.05)',
    default: colors.cardBorder,
    strong: colors.cardBorderStrong,
    accentLime: 'rgba(191, 255, 0, 0.28)',
    accentTeal: 'rgba(10, 212, 196, 0.32)',
    destructive: 'rgba(255, 107, 136, 0.28)',
  },
} as const;

export const elevation = {
  surfaceTier1:
    'inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 14px 34px rgba(0, 0, 0, 0.36)',
  surfaceTier2:
    'inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 16px 36px rgba(0, 0, 0, 0.38)',
  hero:
    'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 18px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(191, 255, 0, 0.08)',
  card: '0 12px 34px rgba(0, 0, 0, 0.35)',
  mobileNav: '0 20px 50px rgba(0, 0, 0, 0.52)',
  modal: '0 24px 60px rgba(0, 0, 0, 0.5)',
} as const;

export const blur = {
  glass: 14,
  glassStrong: 24,
  mobileNav: 20,
} as const;

export const breakpoints = {
  mobileSm: 375,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 20,
  dropdown: 30,
  mobileNav: 40,
  toast: 50,
  modal: 120,
  missionControlFloating: 220,
  missionControlOverlay: 230,
  appTopLayer: 320,
} as const;

export const interaction = {
  minTouchTarget: 44,
  focusRing: {
    width: border.width.focus,
    color: 'rgba(191, 255, 0, 0.35)',
  },
  hoverLiftPx: 2,
  activePressPx: 0.5,
} as const;

export const stateTones = {
  active: {
    border: 'rgba(191, 255, 0, 0.28)',
    background: 'rgba(191, 255, 0, 0.11)',
    text: 'rgba(223, 255, 156, 0.9)',
  },
  done: {
    border: 'rgba(20, 184, 166, 0.26)',
    background: 'rgba(20, 184, 166, 0.11)',
    text: 'rgba(135, 255, 233, 0.9)',
  },
  blocked: {
    border: 'rgba(255, 107, 136, 0.28)',
    background: 'rgba(255, 107, 136, 0.12)',
    text: 'rgba(255, 195, 208, 0.9)',
  },
  planned: {
    border: 'rgba(255, 255, 255, 0.16)',
    background: 'rgba(255, 255, 255, 0.06)',
    text: 'rgba(236, 241, 255, 0.74)',
  },
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
